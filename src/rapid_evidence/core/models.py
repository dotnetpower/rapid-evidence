from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from rapid_evidence.core.ids import new_id


class RequestStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class WorkerStatus(str, Enum):
    READY = "ready"
    BUSY = "busy"
    TERMINATED = "terminated"


@dataclass(frozen=True)
class FetchRequest:
    target: str
    source: str = "generic-http"
    request_id: str = field(init=False)
    headers: dict[str, str] = field(default_factory=dict)
    method: str = "GET"
    body: bytes | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        object.__setattr__(self, "source", self.source.strip().lower())
        object.__setattr__(self, "request_id", new_id("req"))


@dataclass(frozen=True)
class FetchResult:
    request_id: str
    source: str
    target: str
    status: RequestStatus
    body: bytes
    metrics: dict[str, Any]
    error: str | None = None


@dataclass(frozen=True)
class SourcePolicy:
    source: str
    min_delay_seconds: float
    max_concurrency: int
    max_batch_size: int
    max_workers: int
    required_headers: set[str]
    allowed_methods: set[str]
    max_attempts: int
    retry_after_seconds: float
    max_request_bytes: int

    def __post_init__(self):
        object.__setattr__(self, "source", self.source.strip().lower())
        if self.min_delay_seconds < 0:
            raise ValueError("min_delay_seconds must be non-negative")
        if self.max_concurrency <= 0:
            raise ValueError("max_concurrency must be positive")
        if self.max_batch_size <= 0:
            raise ValueError("max_batch_size must be positive")
        if self.max_workers <= 0:
            raise ValueError("max_workers must be positive")
        if self.max_attempts <= 0:
            raise ValueError("max_attempts must be positive")
        if self.retry_after_seconds < 0:
            raise ValueError("retry_after_seconds must be non-negative")
        if self.max_request_bytes <= 0:
            raise ValueError("max_request_bytes must be positive")

    def validate_request(self, request: FetchRequest) -> None:
        if request.source != self.source:
            raise ValueError(f"policy source mismatch: {request.source} != {self.source}")
        if request.method not in self.allowed_methods:
            raise ValueError(f"method {request.method} not allowed")
        missing = self.required_headers - set(request.headers)
        if missing:
            raise ValueError(f"missing required headers: {', '.join(sorted(missing))}")
        if len(request.headers) > 0 and not all(isinstance(v, str) for v in request.headers.values()):
            raise ValueError("headers must be strings")


@dataclass(frozen=True)
class SurgeLimits:
    max_workers: int
    runtime_seconds: float
    max_budget_usd: float = 0.0
    estimated_worker_second_usd: float = 0.0

    def __post_init__(self):
        if self.max_workers <= 0:
            raise ValueError("max_workers must be positive")
        if self.runtime_seconds <= 0:
            raise ValueError("runtime_seconds must be positive")
        if self.max_budget_usd < 0:
            raise ValueError("max_budget_usd must be non-negative")
        if self.estimated_worker_second_usd < 0:
            raise ValueError("estimated_worker_second_usd must be non-negative")


@dataclass(frozen=True)
class WorkerSpec:
    name: str
    env: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        for key in self.env:
            if not key.isidentifier() or not key.isupper() and not key.replace("_", "").isalnum():
                raise ValueError(f"invalid env key: {key}")


@dataclass(frozen=True)
class WorkerLease:
    worker_id: str
    spec: WorkerSpec
    status: WorkerStatus = WorkerStatus.READY


@dataclass(frozen=True)
class WorkerStatusSnapshot:
    worker_id: str
    status: WorkerStatus
    running_requests: int
