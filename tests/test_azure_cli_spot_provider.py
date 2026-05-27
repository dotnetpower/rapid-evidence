import json

from rapid_evidence.spot.azure_cli_provider import AzureCliSpotVmProvider, AzureSpotVmConfig
from rapid_evidence.spot.models import SpotNodeState, SpotPoolConfig


class FakeCompletedProcess:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def test_azure_cli_provider_checks_quota_and_creates_spot_node(monkeypatch):
    calls = []

    def fake_run(cmd, capture_output=None, text=None, check=None, **kwargs):
        calls.append((tuple(cmd), capture_output, text, check, kwargs))
        cmd_tuple = tuple(cmd)
        if cmd_tuple[1:3] == ("vm", "list-usage"):
            return FakeCompletedProcess(stdout=json.dumps({
                "name": {"value": "standardDASv5Family"},
                "currentValue": 1,
                "limit": 5,
            }))
        if cmd_tuple[1:3] == ("group", "create"):
            return FakeCompletedProcess(stdout="{}")
        if cmd_tuple[1:3] == ("network", "nsg") and "create" in cmd_tuple:
            return FakeCompletedProcess(stdout="{}")
        if cmd_tuple[1:5] == ("network", "nsg", "rule", "create"):
            return FakeCompletedProcess(stdout="{}")
        if cmd_tuple[1:3] == ("network", "vnet") and "create" in cmd_tuple:
            return FakeCompletedProcess(stdout="{}")
        if cmd_tuple[1:5] == ("network", "vnet", "subnet", "update"):
            return FakeCompletedProcess(stdout="{}")
        if cmd_tuple[1:3] == ("vm", "create"):
            return FakeCompletedProcess(stdout="created")
        if cmd_tuple[1:3] == ("vm", "list-ip-addresses"):
            return FakeCompletedProcess(stdout="1.2.3.4\n")
        if cmd_tuple[1:3] == ("vm", "list"):
            return FakeCompletedProcess(stdout="[]")
        if cmd_tuple[1] == "version":
            return FakeCompletedProcess(stdout="azure-cli 2.0")
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr("rapid_evidence.spot.azure_cli_provider.subprocess.run", fake_run)

    provider = AzureCliSpotVmProvider(AzureSpotVmConfig(location="koreacentral", resource_group="rg-demo", vm_size="Standard_D2as_v5"))

    quota = provider.check_quota(2, SpotPoolConfig(min_ready=1, max_nodes=3))
    assert quota.used == 1
    assert quota.limit == 5
    assert quota.spot_quota_observed is True
    assert quota.is_sufficient is True

    created = provider.create_nodes(1, SpotPoolConfig(min_ready=1, max_nodes=3))
    assert len(created) == 1
    node = created[0]
    assert node.state == SpotNodeState.READY
    assert node.public_ip == "1.2.3.4"
    assert node.metadata["resource_group"] == "rg-demo"
    assert node.metadata["physical_name"].startswith("rapid-evidence-")

    vm_create_call = next(call for call in calls if tuple(call[0])[1:3] == ("vm", "create"))
    vm_create_command = vm_create_call[0]
    assert "--priority" in vm_create_command
    assert "Spot" in vm_create_command
    assert "--eviction-policy" in vm_create_command
    assert "Delete" in vm_create_command
    assert "--public-ip-sku" in vm_create_command
    assert "--os-disk-delete-option" in vm_create_command
    assert "Delete" in vm_create_command
    assert any(item.startswith("--custom-data") for item in vm_create_command)
    assert any(item.startswith("@") for item in vm_create_command)
