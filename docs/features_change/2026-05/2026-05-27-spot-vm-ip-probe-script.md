# Azure Spot VM IP probe harness

- Added `scripts/spot_vm_ip_probe.py` to create real Spot VMs, invoke each VM to call an outbound IP endpoint, and gather the returned probe output.
- The script provisions a dedicated resource group, collects per-VM probe results, prints structured JSON, and optionally cleans up the resource group.
