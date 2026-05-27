from rapid_evidence.core.models import WorkerLease, WorkerSpec, WorkerStatus


class LocalWorkerProvider:
    def __init__(self):
        self._workers: dict[str, WorkerLease] = {}

    def provision_worker(self, spec: WorkerSpec) -> WorkerLease:
        worker_id = f"local-{len(self._workers)+1}"
        lease = WorkerLease(worker_id=worker_id, spec=spec, status=WorkerStatus.READY)
        self._workers[worker_id] = lease
        return lease

    def terminate_worker(self, worker_id: str) -> None:
        lease = self._workers.pop(worker_id, None)
        if lease is None:
            return
        self._workers[worker_id] = WorkerLease(worker_id=worker_id, spec=lease.spec, status=WorkerStatus.TERMINATED)

    def status(self) -> dict[str, WorkerLease]:
        return dict(self._workers)
