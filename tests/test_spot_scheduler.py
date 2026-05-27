from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.models import SpotPoolConfig
from rapid_evidence.spot.scheduler import SpotVmScheduler


def test_spot_scheduler_scales_to_min_ready_and_releases():
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(provider=provider, config=SpotPoolConfig(min_ready=1, max_nodes=3, idle_timeout_seconds=1))

    scheduler.initialize()
    _snapshot, capacity = scheduler.status(requested_tasks=0)
    assert capacity.target_nodes >= 1

    reservation = scheduler.reserve(requested_tasks=1, task_ids=["task-1"])
    assert reservation.assignments

    scheduler.release(reservation.node_ids)
    scheduler.apply_idle_timeout()

    _snapshot, capacity = scheduler.status(requested_tasks=0)
    assert capacity.target_nodes >= 1
