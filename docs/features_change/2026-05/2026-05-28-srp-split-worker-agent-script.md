# SRP Split — `worker/agent_script.py` → `agent_runtime` + `agent_install`

**Date:** 2026-05-28
**Status:** implemented (pure-move refactor, no behaviour change)

## Why

`worker/agent_script.py` had grown to 352 LOC and was listed
**OVER LIMIT** in `docs/CODEMAP.md` — beyond the 300-line hard ceiling
in the SRP rules. Per copilot-instructions §7, OVER LIMIT files must
be split before more behaviour can be added to them.

## Split

| New file | LOC | Responsibility |
| -------- | --: | -------------- |
| `src/rapid_evidence/worker/agent_runtime.py` | 264 | `AGENT_SCRIPT` constant only — the embedded stdlib-only on-VM fetch daemon source. No host-side imports. |
| `src/rapid_evidence/worker/agent_install.py` | 114 | Host-side install helpers: `DEFAULT_AGENT_PORT`, `generate_agent_secret()`, `AgentInstallSpec` (renders systemd unit + env file + cloud-init `write_files` / `runcmd` blocks). |
| `src/rapid_evidence/worker/agent_script.py` | 29 | Thin backwards-compatible facade — re-exports `AGENT_SCRIPT`, `DEFAULT_AGENT_PORT`, `generate_agent_secret`, `AgentInstallSpec` with an explicit `__all__` so `ruff --fix` does not strip the re-exports. |

The two halves used to share the file by accident — the host never
runs the embedded script and the VM never imports `AgentInstallSpec`.
After the split, `agent_runtime.py` is reachable only by callers that
genuinely need the daemon source (the install helper plus tests),
which means future edits to the daemon do not force a reload of the
host-side install logic.

## Compatibility

- `src/rapid_evidence/spot/azure_cli_provider.py` keeps importing
  `from rapid_evidence.worker.agent_script import (AgentInstallSpec,
  DEFAULT_AGENT_PORT, generate_agent_secret)` — the facade resolves
  it without behaviour change.
- `worker/__init__.py` was not touched (it never re-exported these
  symbols).
- `AGENT_SCRIPT` value is byte-for-byte identical; verified the
  facade returns the same `len(AGENT_SCRIPT)`.

## Verification

- `PYTHONPATH=src uv run pytest` → **47 passed** (same as before the
  split).
- `uv run ruff check src/rapid_evidence/worker/` → **All checks
  passed!**
- Smoke import: `from rapid_evidence.worker.agent_script import
  AGENT_SCRIPT, AgentInstallSpec, generate_agent_secret,
  DEFAULT_AGENT_PORT` succeeds and round-trips through the facade.

## Updated CODEMAP

`docs/CODEMAP.md`:
- `worker/` table now lists `agent_runtime.py`, `agent_install.py`
  and the facade `agent_script.py` separately with their new LOC
  counts.
- SRP debt summary drops `worker/agent_script.py` from the OVER
  LIMIT list (5 → 4 entries).
- `agent_runtime.py` (264) is added to the "watch on the next change"
  list because the embedded daemon string literal is most of its
  weight.

## Affected files

- `src/rapid_evidence/worker/agent_runtime.py` (new)
- `src/rapid_evidence/worker/agent_install.py` (new)
- `src/rapid_evidence/worker/agent_script.py` (replaced with facade)
- `docs/CODEMAP.md`
