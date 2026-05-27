# Azure Spot quota-aware provider

- Implemented `AzureCliSpotVmProvider` backed by Azure CLI subprocess calls.
- Added region-aware quota checks against `az vm list-usage` for the configured VM family.
- Added idempotent infrastructure setup and Spot VM creation with cloud-init and explicit delete semantics.
- Added regression coverage for quota checks, Node creation, and CLI quota reporting.
