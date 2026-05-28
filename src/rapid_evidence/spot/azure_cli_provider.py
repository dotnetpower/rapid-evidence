import atexit
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field

from rapid_evidence.core.errors import ProviderError
from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.models import QuotaSnapshot, SpotNode, SpotNodeState, SpotPoolConfig
from rapid_evidence.worker.agent_script import (
    AgentInstallSpec,
    DEFAULT_AGENT_PORT,
    generate_agent_secret,
)


@dataclass(frozen=True)
class AzureSpotVmConfig:
    location: str = "koreacentral"
    resource_group: str = "rapid-evidence"
    vm_size: str = "Standard_D2as_v5"
    vm_size_fallbacks: tuple[str, ...] = field(default_factory=tuple)
    availability_zones: tuple[str, ...] = field(default_factory=tuple)
    image: str = "Ubuntu2204"
    nsg_name: str = "rapid-evidence-egress-only"
    address_prefix: str = "10.42.0.0/16"
    subnet_prefix: str = "10.42.0.0/24"
    max_price_usd: float = -1.0
    probe_urls: tuple[str, ...] = ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")
    vcpus_per_vm: int = 2
    spot_quota_name: str = "standardDASv5Family"
    create_concurrency: int = 10
    probe_concurrency: int = 10
    cloud_init_enabled: bool = True
    vm_name_prefix: str = "rapid-evidence"
    subscription: str | None = None
    agent_port: int = DEFAULT_AGENT_PORT
    agent_shared_secret: str | None = None
    agent_enabled: bool = True

    def __post_init__(self):
        if not self.location.strip():
            raise ValueError("location must be non-empty")
        if not self.resource_group.strip():
            raise ValueError("resource_group must be non-empty")
        if not self.vm_size.strip():
            raise ValueError("vm_size must be non-empty")
        if self.vcpus_per_vm <= 0:
            raise ValueError("vcpus_per_vm must be positive")
        if self.create_concurrency <= 0:
            raise ValueError("create_concurrency must be positive")
        if self.probe_concurrency <= 0:
            raise ValueError("probe_concurrency must be positive")


class AzureCliSpotVmProvider(InMemorySpotVmProvider):
    provider_name = "azure-cli"

    def __init__(self, config: AzureSpotVmConfig):
        super().__init__()
        self.config = config
        self._rotation_index = 0
        self._created_count = 0
        self._temp_paths = []
        self._cloud_init_path = None
        self._name_to_node_id = {}
        self._cleanup_registered = False
        self._agent_shared_secret = (
            config.agent_shared_secret
            if config.agent_shared_secret
            else generate_agent_secret()
        )
        self._ensure_az_cli()

    @property
    def agent_shared_secret(self) -> str:
        return self._agent_shared_secret

    @property
    def agent_port(self) -> int:
        return self.config.agent_port

    def _agent_install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            port=self.config.agent_port,
            shared_secret=self._agent_shared_secret,
        )

    def _ensure_az_cli(self):
        if subprocess.run(["az", "version"], capture_output=True, text=True).returncode != 0:
            raise ProviderError("Azure CLI is not available on PATH")

    def _run_az(self, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        command = ["az", *args]
        if self.config.subscription:
            command.extend(["--subscription", self.config.subscription])
        result = subprocess.run(command, capture_output=True, text=True)
        if check and result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip() or "unknown az CLI failure"
            raise ProviderError(f"Azure CLI command failed: {' '.join(command)} -> {detail}")
        return result

    def _cleanup_temp_files(self):
        for path in list(self._temp_paths):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            finally:
                if path in self._temp_paths:
                    self._temp_paths.remove(path)

    def _register_cleanup(self):
        if not self._cleanup_registered:
            atexit.register(self._cleanup_temp_files)
            self._cleanup_registered = True

    def _render_cloud_init(self) -> str:
        probe_script = """import json
import urllib.request
from pathlib import Path

urls = ["""
        probe_script += ",\n".join(f"    {url!r}" for url in self.config.probe_urls)
        probe_script += """]

path = Path('/var/log/rapid-evidence/outbound_ip.json')
path.parent.mkdir(parents=True, exist_ok=True)
for url in urls:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read().decode('utf-8').strip()
        path.write_text(json.dumps({'url': url, 'ip': body}))
        break
    except Exception:
        continue
"""

        eviction_script = """import json
import time
import urllib.request
from pathlib import Path

path = Path('/var/log/rapid-evidence/eviction.json')
path.parent.mkdir(parents=True, exist_ok=True)
while True:
    try:
        with urllib.request.urlopen('http://169.254.169.254/metadata/scheduledevents?api-version=2020-09-01', timeout=2) as response:
            payload = response.read().decode('utf-8')
            if payload:
                path.write_text(json.dumps({'event': payload, 'ts': time.time()}))
    except Exception:
        pass
    time.sleep(5)
"""

        agent_block = ""
        agent_runcmd: list[str] = []
        if self.config.agent_enabled:
            spec = self._agent_install_spec()
            agent_block = spec.cloud_init_block(probe_urls=self.config.probe_urls)
            agent_runcmd = spec.runcmd_block()

        runcmd_lines = [
            "mkdir -p /var/log/rapid-evidence",
            "python3 /opt/rapid-evidence/outbound_probe.py || true",
            "systemctl daemon-reload",
            "systemctl enable --now rapid-evidence-eviction.service",
            *agent_runcmd,
        ]
        runcmd_yaml = "\n".join(f"  - {line}" for line in runcmd_lines)

        return f"""#cloud-config
write_files:
  - path: /opt/rapid-evidence/eviction_watcher.py
    permissions: '0755'
    content: |
{eviction_script}
  - path: /opt/rapid-evidence/outbound_probe.py
    permissions: '0755'
    content: |
{probe_script}
  - path: /etc/systemd/system/rapid-evidence-eviction.service
    permissions: '0644'
    content: |
      [Unit]
      Description=Rapid Evidence Spot outbound watcher
      After=network-online.target

      [Service]
      Type=simple
      ExecStart=/usr/bin/python3 /opt/rapid-evidence/eviction_watcher.py
      Restart=always
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
{agent_block}runcmd:
{runcmd_yaml}
""".replace("{eviction_script}", eviction_script).replace("{probe_script}", probe_script)

    def _write_cloud_init(self) -> str:
        if not self.config.cloud_init_enabled:
            return ""
        cloud_init = self._render_cloud_init()
        handle = tempfile.NamedTemporaryFile("w", delete=False, prefix="rapid-evidence-cloud-init-", suffix=".yml", dir="/tmp")
        try:
            handle.write(cloud_init)
            handle.flush()
            os.fchmod(handle.fileno(), 0o600)
            path = handle.name
        finally:
            handle.close()
        self._temp_paths.append(path)
        self._register_cleanup()
        self._cloud_init_path = path
        return path

    def _ensure_infrastructure(self):
        try:
            self._run_az(["group", "create", "--name", self.config.resource_group, "--location", self.config.location, "--output", "none"])
        except ProviderError:
            pass
        try:
            self._run_az(["network", "nsg", "create", "--resource-group", self.config.resource_group, "--name", self.config.nsg_name, "--location", self.config.location, "--output", "none"])
        except ProviderError:
            pass
        try:
            self._run_az(["network", "nsg", "rule", "create", "--resource-group", self.config.resource_group, "--nsg-name", self.config.nsg_name, "--name", "deny-all-inbound", "--priority", "4000", "--direction", "Inbound", "--access", "Deny", "--protocol", "*", "--source-address-prefix", "*", "--source-port-range", "*", "--destination-address-prefix", "*", "--destination-port-range", "*", "--description", "deny all inbound", "--output", "none"])
        except ProviderError:
            pass
        try:
            self._run_az(["network", "vnet", "create", "--resource-group", self.config.resource_group, "--name", "rapid-evidence-vnet", "--location", self.config.location, "--address-prefix", self.config.address_prefix, "--subnet-name", "rapid-evidence-subnet", "--subnet-prefix", self.config.subnet_prefix, "--output", "none"])
        except ProviderError:
            pass
        try:
            self._run_az(["network", "vnet", "subnet", "update", "--resource-group", self.config.resource_group, "--vnet-name", "rapid-evidence-vnet", "--name", "rapid-evidence-subnet", "--network-security-group", self.config.nsg_name, "--output", "none"])
        except ProviderError:
            pass
        if self.config.agent_enabled:
            try:
                self._run_az([
                    "network", "nsg", "rule", "create",
                    "--resource-group", self.config.resource_group,
                    "--nsg-name", self.config.nsg_name,
                    "--name", "allow-agent-inbound",
                    "--priority", "300",
                    "--direction", "Inbound",
                    "--access", "Allow",
                    "--protocol", "Tcp",
                    "--source-address-prefix", "Internet",
                    "--source-port-range", "*",
                    "--destination-address-prefix", "*",
                    "--destination-port-range", str(self.config.agent_port),
                    "--description", "rapid-evidence agent (bearer-auth)",
                    "--output", "none",
                ])
            except ProviderError:
                pass

    def _size_rotation(self):
        sizes = [self.config.vm_size, *self.config.vm_size_fallbacks]
        if not sizes:
            raise ProviderError("no VM sizes configured")
        current = sizes[self._rotation_index % len(sizes)]
        self._rotation_index = (self._rotation_index + 1) % len(sizes)
        return current

    def _zone_rotation(self):
        zones = list(self.config.availability_zones)
        if not zones:
            return None
        zone = zones[self._rotation_index % len(zones)]
        self._rotation_index = (self._rotation_index + 1) % len(zones)
        return zone

    def _query_public_ip(self, vm_name: str) -> str | None:
        try:
            result = self._run_az(["vm", "list-ip-addresses", "--resource-group", self.config.resource_group, "--name", vm_name, "--query", "[0].virtualMachine.network.publicIpAddresses[0].ipAddress", "-o", "tsv"], check=False)
        except ProviderError:
            return None
        if result.returncode != 0:
            return None
        ip = result.stdout.strip()
        return ip or None

    def discover_existing_nodes(self) -> tuple[SpotNode, ...]:
        try:
            result = self._run_az(["vm", "list", "--resource-group", self.config.resource_group, "--query", "[?tags.rapid-evidence-managed=='true'].{name:name, powerState:powerState, provisioningState:provisioningState, location:location, vmSize:hardwareProfile.vmSize, zone:zones[0], nodeId:tags.rapid-evidence-node-id, publicIp:publicIps[0]}", "-o", "json"])
        except ProviderError:
            return tuple()
        payload = json.loads(result.stdout or "[]")
        refreshed = []
        for item in payload:
            logical_id = item.get("nodeId") or item["name"]
            name = item["name"]
            power_state = str(item.get("powerState") or "").lower()
            if "running" in power_state or "starting" in power_state:
                state = SpotNodeState.READY
            elif "deallocated" in power_state or "stopped" in power_state:
                state = SpotNodeState.TERMINATED
            elif "failed" in str(item.get("provisioningState") or "").lower():
                state = SpotNodeState.FAILED
            else:
                state = SpotNodeState.PROVISIONING
            public_ip = self._query_public_ip(name)
            node = SpotNode(
                node_id=logical_id,
                name=name,
                state=state,
                public_ip=public_ip,
                outbound_ip=public_ip,
                inflight=0,
                vm_size=item.get("vmSize"),
                zone=item.get("zone"),
                metadata={
                    "resource_group": self.config.resource_group,
                    "region": self.config.location,
                    "physical_name": name,
                    "power_state": item.get("powerState"),
                    "provisioning_state": item.get("provisioningState"),
                },
            )
            self._nodes[node.node_id] = node
            self._name_to_node_id[name] = node.node_id
            refreshed.append(node)
        return tuple(refreshed)

    def check_quota(self, requested_nodes: int, config: SpotPoolConfig) -> QuotaSnapshot:
        if requested_nodes < 0:
            raise ValueError("requested_nodes must be non-negative")
        try:
            result = self._run_az(["vm", "list-usage", "--location", self.config.location, "--query", f"[?name.value=='{self.config.spot_quota_name}'] | [0]", "-o", "json"])
        except ProviderError:
            return QuotaSnapshot(used=0, limit=0, spot_quota_observed=False, public_ip_quota_observed=False, is_sufficient=False)
        data = json.loads(result.stdout or "[]")
        if not isinstance(data, dict):
            return QuotaSnapshot(used=0, limit=0, spot_quota_observed=False, public_ip_quota_observed=False, is_sufficient=False)
        used = int(data.get("currentValue") or 0)
        limit = int(data.get("limit") or 0)
        is_sufficient = (used + requested_nodes) <= limit
        return QuotaSnapshot(used=used, limit=limit, spot_quota_observed=True, public_ip_quota_observed=False, is_sufficient=is_sufficient)

    def create_nodes(self, count: int, config: SpotPoolConfig) -> tuple[SpotNode, ...]:
        if count <= 0:
            return tuple()
        quota = self.check_quota(count, config)
        if not quota.is_sufficient:
            raise ProviderError(f"Insufficient quota in {self.config.location}: used {quota.used} of {quota.limit} for {count} requested nodes")

        self._ensure_infrastructure()

        created = []
        for _ in range(count):
            self._created_count += 1
            logical_id = f"spot-node-{self._created_count:03d}"
            node_name = f"{self.config.vm_name_prefix}-{self._created_count:03d}"
            vm_size = self._size_rotation()
            zone = self._zone_rotation()
            cloud_init_path = self._write_cloud_init() if self.config.cloud_init_enabled else None

            create_command = [
                "vm", "create",
                "--name", node_name,
                "--resource-group", self.config.resource_group,
                "--location", self.config.location,
                "--image", self.config.image,
                "--size", vm_size,
                "--vnet-name", "rapid-evidence-vnet",
                "--subnet", "rapid-evidence-subnet",
                "--public-ip-sku", "Standard",
                "--priority", "Spot",
                "--max-price", str(self.config.max_price_usd),
                "--eviction-policy", "Delete",
                "--os-disk-delete-option", "Delete",
                "--nic-delete-option", "Delete",
                "--admin-username", "azureuser",
                "--generate-ssh-keys",
                "--tags", f"rapid-evidence-managed=true rapid-evidence-node-id={logical_id} rapid-evidence-provider=azure-cli rapid-evidence-region={self.config.location}",
            ]
            if cloud_init_path:
                create_command.extend(["--custom-data", f"@{cloud_init_path}"])
            if zone:
                create_command.extend(["--zone", zone])

            self._run_az(create_command)

            public_ip = self._query_public_ip(node_name)
            node = SpotNode(
                node_id=logical_id,
                name=node_name,
                state=SpotNodeState.READY,
                public_ip=public_ip,
                outbound_ip=public_ip,
                inflight=0,
                vm_size=vm_size,
                zone=zone,
                metadata={
                    "resource_group": self.config.resource_group,
                    "region": self.config.location,
                    "physical_name": node_name,
                    "logical_id": logical_id,
                    "tags": {
                        "rapid-evidence-managed": "true",
                        "rapid-evidence-node-id": logical_id,
                        "rapid-evidence-provider": "azure-cli",
                        "rapid-evidence-region": self.config.location,
                    },
                },
            )
            self._nodes[logical_id] = node
            self._name_to_node_id[node_name] = logical_id
            created.append(node)

        return tuple(created)

    def refresh_nodes(self) -> tuple[SpotNode, ...]:
        nodes = self.discover_existing_nodes()
        return tuple(nodes)

    def terminate_nodes(self, node_ids: tuple[str, ...]) -> tuple[str, ...]:
        terminated = []
        for node_id in node_ids:
            node = self._nodes.get(node_id)
            if node is None:
                continue
            self._run_az(["vm", "delete", "--name", node.name, "--resource-group", self.config.resource_group, "--yes"], check=False)
            terminated_node = SpotNode(
                node_id=node.node_id,
                name=node.name,
                state=SpotNodeState.TERMINATED,
                public_ip=node.public_ip,
                outbound_ip=node.outbound_ip,
                inflight=node.inflight,
                vm_size=node.vm_size,
                zone=node.zone,
                metadata=node.metadata,
                error="terminated",
            )
            self._nodes[node_id] = terminated_node
            terminated.append(node_id)
        return tuple(terminated)
