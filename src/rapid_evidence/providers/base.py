from typing import Protocol

from rapid_evidence.core.models import WorkerLease, WorkerSpec


class WorkerProvider(Protocol):
    def provision_worker(self, spec: WorkerSpec) -> WorkerLease:
        ...

    def terminate_worker(self, worker_id: str) -> None:
        ...

    def status(self) -> dict[str, WorkerLease]:
        ...
