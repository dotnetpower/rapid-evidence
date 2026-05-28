"""Backwards-compatible facade for the worker agent helpers.

The on-VM daemon source (`AGENT_SCRIPT`) and the host-side install
helpers (`AgentInstallSpec`, `generate_agent_secret`,
`DEFAULT_AGENT_PORT`) used to all live in this single module. They
have since been split into `agent_runtime` and `agent_install` to keep
each file under the 300-line SRP ceiling. This module re-exports the
same names so existing imports (`from rapid_evidence.worker.agent_script
import ...`) keep working without behaviour change.

`__all__` is defined explicitly so `ruff --fix` does not strip the
re-exports as unused imports.
"""

from __future__ import annotations

from rapid_evidence.worker.agent_install import (
    DEFAULT_AGENT_PORT,
    AgentInstallSpec,
    generate_agent_secret,
)
from rapid_evidence.worker.agent_runtime import AGENT_SCRIPT

__all__ = [
    "AGENT_SCRIPT",
    "DEFAULT_AGENT_PORT",
    "AgentInstallSpec",
    "generate_agent_secret",
]
