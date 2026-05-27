from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from time import perf_counter

from rapid_evidence.core.errors import PolicyViolationError
from rapid_evidence.core.models import FetchRequest, FetchResult, RequestStatus, SourcePolicy, SurgeLimits
from rapid_evidence.policy.policy_store import PolicyStore


@dataclass(frozen=True)
class SurgePlan:
    completed: int
    failed: int
    elapsed_seconds: float
    target_workers: int


class SurgeOrchestrator:
    def __init__(self, policies: PolicyStore, limits: SurgeLimits):
        self.policies = policies
        self.limits = limits

    def run_local_once(self, source: str, queue, sink, provider, source_client) -> SurgePlan:
        policy = self.policies.require(source)
        if policy.max_workers < 1:
            raise PolicyViolationError("policy has no workers")

        start = perf_counter()
        completed = 0
        failed = 0
        worker_count = 0

        with ThreadPoolExecutor(max_workers=min(self.limits.max_workers, policy.max_workers)) as executor:
            futures = []
            while True:
                batch = queue.dequeue_batch(source=source, n=min(policy.max_batch_size, self.limits.max_workers))
                if not batch:
                    break
                for request in batch:
                    worker_count += 1
                    futures.append(executor.submit(self._run_request, request, source_client, sink))
                for future in as_completed(futures):
                    result = future.result()
                    if result.status == RequestStatus.SUCCEEDED:
                        completed += 1
                    else:
                        failed += 1
                futures.clear()

        elapsed = perf_counter() - start
        return SurgePlan(completed=completed, failed=failed, elapsed_seconds=elapsed, target_workers=worker_count)

    def _run_request(self, request: FetchRequest, source_client, sink) -> FetchResult:
        try:
            fetched = source_client.fetch(request.target, headers=request.headers)
            result = FetchResult(
                request_id=request.request_id,
                source=request.source,
                target=request.target,
                status=RequestStatus.SUCCEEDED,
                body=fetched["body"],
                metrics={"bytes": len(fetched["body"]), "status_code": fetched.get("status")},
            )
            sink.write(result)
            return result
        except Exception as exc:
            result = FetchResult(
                request_id=request.request_id,
                source=request.source,
                target=request.target,
                status=RequestStatus.FAILED,
                body=b"",
                metrics={"bytes": 0},
                error=str(exc),
            )
            sink.write(result)
            return result
