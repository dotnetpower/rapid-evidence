import argparse
import json

from rapid_evidence.core.models import FetchRequest
from rapid_evidence.orchestrator.scheduler import SurgeOrchestrator
from rapid_evidence.policy.defaults import default_policy_store
from rapid_evidence.providers.local import LocalWorkerProvider
from rapid_evidence.queue.memory import MemoryRequestQueue
from rapid_evidence.sources.generic_http import GenericHttpSource
from rapid_evidence.storage.filesystem import FileSystemResultSink


def main(argv=None):
    parser = argparse.ArgumentParser(prog="rapidfetch")
    subparsers = parser.add_subparsers(dest="command")

    run_local = subparsers.add_parser("run-local")
    run_local.add_argument("--url", action="append", required=True)
    run_local.add_argument("--source", default="generic-http")
    run_local.add_argument("--batch-size", type=int, default=4)
    run_local.add_argument("--output-dir", default=".rapid-evidence")

    spot_plan = subparsers.add_parser("spot-plan")
    spot_plan.add_argument("--min-ready", type=int, default=1)
    spot_plan.add_argument("--max-nodes", type=int, default=3)
    spot_plan.add_argument("--provider", choices=["in-memory", "azure-cli"], default="in-memory")
    spot_plan.add_argument("--region", default="koreacentral")
    spot_plan.add_argument("--resource-group", default="rapid-evidence")
    spot_plan.add_argument("--vm-size", default="Standard_D2as_v5")

    spot_quota = subparsers.add_parser("spot-quota")
    spot_quota.add_argument("--region", default="koreacentral")
    spot_quota.add_argument("--requested-nodes", type=int, default=1)
    spot_quota.add_argument("--resource-group", default="rapid-evidence")
    spot_quota.add_argument("--vm-size", default="Standard_D2as_v5")

    args = parser.parse_args(argv)
    if args.command == "run-local":
        policies = default_policy_store()
        policy = policies.require(args.source)
        queue = MemoryRequestQueue(max_queued=1024)
        for url in args.url:
            request = FetchRequest(target=url, source=args.source)
            policy.validate_request(request)
            queue.enqueue(request)
        orchestrator = SurgeOrchestrator(policies=policies, limits=type("Limits", (), {"max_workers": policy.max_workers, "runtime_seconds": 60.0, "max_budget_usd": 0.0, "estimated_worker_second_usd": 0.0})())
        sink = FileSystemResultSink(args.output_dir)
        provider = LocalWorkerProvider()
        source_client = GenericHttpSource(max_body_bytes=policy.max_request_bytes, timeout_seconds=30.0, max_attempts=policy.max_attempts)
        plan = orchestrator.run_local_once(args.source, queue, sink, provider, source_client)
        print(json.dumps({"completed": plan.completed, "failed": plan.failed, "elapsed_seconds": plan.elapsed_seconds, "target_workers": plan.target_workers}))
        return 0
    if args.command == "spot-plan":
        from rapid_evidence.spot.fake import InMemorySpotVmProvider
        from rapid_evidence.spot.models import SpotPoolConfig
        from rapid_evidence.spot.scheduler import SpotVmScheduler

        if args.provider == "azure-cli":
            from rapid_evidence.spot.azure_cli_provider import AzureCliSpotVmProvider, AzureSpotVmConfig

            provider = AzureCliSpotVmProvider(AzureSpotVmConfig(
                location=args.region,
                resource_group=args.resource_group,
                vm_size=args.vm_size,
            ))
        else:
            provider = InMemorySpotVmProvider()

        scheduler = SpotVmScheduler(provider=provider, config=SpotPoolConfig(min_ready=args.min_ready, max_nodes=args.max_nodes))
        scheduler.initialize()
        snapshot, capacity = scheduler.status(requested_tasks=0)
        print(json.dumps({"snapshot": snapshot, "capacity": capacity.__dict__}))
        return 0
    if args.command == "spot-quota":
        from rapid_evidence.spot.azure_cli_provider import AzureCliSpotVmProvider, AzureSpotVmConfig
        from rapid_evidence.spot.models import SpotPoolConfig

        provider = AzureCliSpotVmProvider(AzureSpotVmConfig(
            location=args.region,
            resource_group=args.resource_group,
            vm_size=args.vm_size,
        ))
        quota = provider.check_quota(args.requested_nodes, SpotPoolConfig(min_ready=max(1, args.requested_nodes), max_nodes=max(1, args.requested_nodes)))
        print(json.dumps({
            "region": args.region,
            "requested_nodes": args.requested_nodes,
            "used": quota.used,
            "limit": quota.limit,
            "remaining": quota.limit - quota.used,
            "sufficient": quota.is_sufficient,
            "spot_quota_observed": quota.spot_quota_observed,
        }))
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
