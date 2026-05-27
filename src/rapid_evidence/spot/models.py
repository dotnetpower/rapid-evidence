from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class SpotNodeState(StrEnum):
    PROVISIONING = "provisioning"
    READY = "ready"
    BUSY = "busy"
    DRAINING = "draining"
    TERMINATING = "terminating"
    TERMINATED = "terminated"
    FAILED = "failed"
    EVICTED = "evicted"


@dataclass(frozen=True)
class SpotPoolConfig:
    min_ready: int = 1
    max_nodes: int = 4
    per_node_concurrency: int = 1
    scale_up_batch: int = 1
    scale_down_batch: int = 1
    ready_timeout_seconds: int = 300
    cleanup_retries: int = 3
    idle_timeout_seconds: int = 600
    idle_floor: int | None = None
    max_same_subnet_share: float = 0.5

    def __post_init__(self):
        if self.min_ready < 0:
            raise ValueError("min_ready must be non-negative")
        if self.max_nodes <= 0:
            raise ValueError("max_nodes must be positive")
        if self.per_node_concurrency <= 0:
            raise ValueError("per_node_concurrency must be positive")
        if self.scale_up_batch <= 0:
            raise ValueError("scale_up_batch must be positive")
        if self.scale_down_batch <= 0:
            raise ValueError("scale_down_batch must be positive")
        if self.ready_timeout_seconds <= 0:
            raise ValueError("ready_timeout_seconds must be positive")
        if self.cleanup_retries <= 0:
            raise ValueError("cleanup_retries must be positive")
        if self.idle_timeout_seconds <= 0:
            raise ValueError("idle_timeout_seconds must be positive")
        if self.max_same_subnet_share <= 0 or self.max_same_subnet_share > 1:
            raise ValueError("max_same_subnet_share must be in (0, 1]")


@dataclass(frozen=True)
class SpotNode:
    node_id: str
    name: str
    state: SpotNodeState
    public_ip: str | None
    outbound_ip: str | None
    inflight: int = 0
    vm_size: str | None = None
    zone: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def active(self) -> bool:
        return self.state not in {SpotNodeState.TERMINATED, SpotNodeState.FAILED, SpotNodeState.EVICTED}

    @property
    def ready(self) -> bool:
        return self.state == SpotNodeState.READY and self.inflight == 0


@dataclass(frozen=True)
class SpotCapacityPlan:
    immediate_tasks: int
    queued_tasks: int
    overflow_tasks: int
    target_nodes: int
    scale_up_nodes: int
    scale_down_nodes: int
    estimated_new_ready_seconds: float


@dataclass(frozen=True)
class SpotReservation:
    node_ids: tuple[str, ...]
    assignments: dict[str, tuple[str, ...]]
    unassigned_task_ids: tuple[str, ...]


@dataclass(frozen=True)
class EvictionEvent:
    node_id: str
    public_ip: str | None
    reason: str
    requeue_task_ids: tuple[str, ...]


@dataclass(frozen=True)
class QuotaSnapshot:
    used: int
    limit: int
    spot_quota_observed: bool
    public_ip_quota_observed: bool
    is_sufficient: bool


@dataclass(frozen=True)
class IpDistribution:
    total_with_ip: int
    unique_subnets: int
    largest_subnet_share: float
    violates_max_share: bool


@dataclass(frozen=True)
class CleanupReport:
    terminated: tuple[str, ...]
    failed: tuple[str, ...]
