#!/usr/bin/env python3

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from rapid_evidence.spot.azure_cli_provider import AzureCliSpotVmProvider, AzureSpotVmConfig
from rapid_evidence.spot.models import SpotPoolConfig


def run_az(args, *, check=True):
    command = ["az", *args]
    result = subprocess.run(command, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"Azure CLI command failed: {' '.join(command)}\n{result.stderr.strip() or result.stdout.strip()}")
    return result


def parse_args():
    parser = argparse.ArgumentParser(
        description="Create real Spot VMs, invoke each VM to read its external IP, and print gathered results."
    )
    parser.add_argument("--location", default="koreacentral", help="Azure region to use")
    parser.add_argument("--vm-size", default="Standard_D2as_v5", help="VM size to provision")
    parser.add_argument("--count", type=int, default=1, help="Number of Spot VMs to create")
    parser.add_argument("--resource-group-prefix", default="rapid-evidence-ip-probe", help="Prefix used for generated resource group")
    parser.add_argument("--keep-resource-group", action="store_true", help="Keep the generated resource group after the probe")
    parser.add_argument("--probe-url", default="https://api.ipify.org", help="URL each VM will call to report its outbound IP")
    return parser.parse_args()


def main():
    args = parse_args()
    timestamp = int(time.time())
    resource_group = f"{args.resource_group_prefix}-{timestamp}"
    vm_prefix = "rapid-evidence-ip-probe"

    provider = AzureCliSpotVmProvider(
        AzureSpotVmConfig(
            location=args.location,
            resource_group=resource_group,
            vm_size=args.vm_size,
            vm_name_prefix=vm_prefix,
        )
    )

    created = provider.create_nodes(args.count, SpotPoolConfig(min_ready=args.count, max_nodes=args.count))

    gathered = []
    for node in created:
        vm_name = node.name
        result = run_az([
            "vm",
            "run-command",
            "invoke",
            "--resource-group",
            resource_group,
            "--name",
            vm_name,
            "--command-id",
            "RunShellScript",
            "--scripts",
            f"curl -fsSL {args.probe_url}",
            "-o",
            "json",
        ])

        payload = json.loads(result.stdout or "{}")
        message = payload.get("value") or []
        outputs = []
        for item in message:
            if isinstance(item, dict):
                outputs.append(item.get("message"))
        gathered.append({
            "node_id": node.node_id,
            "name": vm_name,
            "public_ip": node.public_ip,
            "outbound_probe_result": "\n".join(filter(None, outputs)),
            "resource_group": resource_group,
            "location": args.location,
            "vm_size": node.vm_size,
        })

    print(json.dumps({
        "resource_group": resource_group,
        "location": args.location,
        "probe_url": args.probe_url,
        "nodes": gathered,
    }, indent=2))

    if not args.keep_resource_group:
        try:
            run_az(["group", "delete", "--name", resource_group, "--yes", "--no-wait"])
        except RuntimeError:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
