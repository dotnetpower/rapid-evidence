"""Host-side helpers that drop the on-VM agent onto a Spot VM.

`AgentInstallSpec` renders the systemd unit, env file and cloud-init
`write_files` + `runcmd` fragments the host needs to splice into a
larger cloud-init document. `generate_agent_secret()` mints the shared
secret the on-VM agent and `HttpWorkerTransport` use to authenticate.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from rapid_evidence.worker.agent_runtime import AGENT_SCRIPT

__all__ = [
    "DEFAULT_AGENT_PORT",
    "AgentInstallSpec",
    "generate_agent_secret",
]


DEFAULT_AGENT_PORT = 8765


def generate_agent_secret() -> str:
    return secrets.token_urlsafe(32)


@dataclass(frozen=True)
class AgentInstallSpec:
    """Bundle of files that the host needs to drop on a Spot VM."""

    agent_script_path: str = "/opt/rapid-evidence/agent.py"
    env_file_path: str = "/etc/rapid-evidence/agent.env"
    systemd_unit_path: str = "/etc/systemd/system/rapid-evidence-agent.service"
    port: int = DEFAULT_AGENT_PORT
    shared_secret: str = ""

    def systemd_unit(self) -> str:
        return (
            "[Unit]\n"
            "Description=Rapid Evidence on-VM fetch agent\n"
            "After=network-online.target\n"
            "Wants=network-online.target\n"
            "\n"
            "[Service]\n"
            "Type=simple\n"
            f"EnvironmentFile={self.env_file_path}\n"
            f"ExecStart=/usr/bin/python3 {self.agent_script_path}\n"
            "Restart=always\n"
            "RestartSec=3\n"
            "User=root\n"
            "AmbientCapabilities=CAP_NET_BIND_SERVICE\n"
            "\n"
            "[Install]\n"
            "WantedBy=multi-user.target\n"
        )

    def env_file_body(self) -> str:
        if not self.shared_secret:
            raise ValueError("shared_secret is required to render env file")
        return (
            f"RAPID_EVIDENCE_AGENT_SECRET={self.shared_secret}\n"
            f"RAPID_EVIDENCE_AGENT_PORT={self.port}\n"
        )

    def cloud_init_block(self, *, probe_urls: tuple[str, ...]) -> str:
        """Render the cloud-init YAML fragments that install the agent.

        Returns a string with `write_files:` and `runcmd:` entries that
        a host can splice into a larger cloud-init document. Each line
        is prefixed appropriately for a YAML block scalar.
        """
        if not self.shared_secret:
            raise ValueError("shared_secret is required to render cloud-init")
        # `probe_urls` is accepted for future use (env override) but
        # the on-VM agent already ships its own default list via the
        # `RAPID_EVIDENCE_AGENT_PROBE_URLS` env. Keep the arg in the
        # signature so callers don't break when we start splicing it.
        _ = probe_urls
        agent_script_lines = "\n".join(
            f"      {line}" if line else "" for line in AGENT_SCRIPT.splitlines()
        )
        unit_lines = "\n".join(
            f"      {line}" if line else "" for line in self.systemd_unit().splitlines()
        )
        env_lines = "\n".join(
            f"      {line}" if line else "" for line in self.env_file_body().splitlines()
        )
        return (
            f"  - path: {self.agent_script_path}\n"
            "    permissions: '0755'\n"
            "    owner: root:root\n"
            "    content: |\n"
            f"{agent_script_lines}\n"
            f"  - path: {self.env_file_path}\n"
            "    permissions: '0600'\n"
            "    owner: root:root\n"
            "    content: |\n"
            f"{env_lines}\n"
            f"  - path: {self.systemd_unit_path}\n"
            "    permissions: '0644'\n"
            "    owner: root:root\n"
            "    content: |\n"
            f"{unit_lines}\n"
        )

    def runcmd_block(self) -> list[str]:
        return [
            "mkdir -p /etc/rapid-evidence /opt/rapid-evidence",
            "systemctl daemon-reload",
            "systemctl enable --now rapid-evidence-agent.service",
        ]
