from __future__ import annotations

import asyncio

import pytest

from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.manager import SpotPoolManager
from rapid_evidence.spot.models import SpotNodeState, SpotPoolConfig
from rapid_evidence.spot.scheduler import SpotVmScheduler


def _build_manager(min_ready=2, max_nodes=4, **kwargs):
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(
        provider=provider,
        config=SpotPoolConfig(min_ready=min_ready, max_nodes=max_nodes, idle_timeout_seconds=60),
    )
    manager = SpotPoolManager(
        scheduler=scheduler,
        heartbeat_interval=kwargs.pop("heartbeat_interval", 0.05),
        reconcile_interval=kwargs.pop("reconcile_interval", 0.05),
        **kwargs,
    )
    return provider, scheduler, manager


def test_manager_start_warms_pool_to_min_ready_and_records_metrics():
    async def scenario():
        provider, scheduler, manager = _build_manager(min_ready=3, max_nodes=5)
        await manager.start(background=False)
        try:
            snap = manager.snapshot()
            assert snap["running"] is True
            assert snap["counters"]["ready"] >= 3
            assert snap["metrics"]["nodes_created_total"] >= 3
            assert snap["config"]["min_ready"] == 3
            event_types = [event["event_type"] for event in snap["recent_events"]]
            assert "pool_started" in event_types
            assert "pool_warmed" in event_types
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_manager_stop_terminates_all_nodes_and_increments_terminated_metric():
    async def scenario():
        provider, scheduler, manager = _build_manager(min_ready=2)
        await manager.start(background=False)
        ready_before = sum(
            1 for n in provider.nodes.values() if n.state == SpotNodeState.READY
        )
        assert ready_before == 2

        await manager.stop()
        assert all(node.state == SpotNodeState.TERMINATED for node in provider.nodes.values())
        snap = manager.snapshot()
        assert snap["metrics"]["nodes_terminated_total"] >= 2

    asyncio.run(scenario())


def test_heartbeat_detects_eviction_and_reconcile_replaces_node():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=2, max_nodes=4, heartbeat_interval=60, reconcile_interval=60
        )
        await manager.start(background=False)
        try:
            initial = list(scheduler._nodes.values())
            assert len(initial) == 2

            # Externally evict one VM (simulating Azure reclaim).
            victim = initial[0]
            provider.simulate_state(victim.node_id, SpotNodeState.EVICTED)

            events = await manager.heartbeat_once()
            assert len(events) == 1
            assert events[0].node_id == victim.node_id
            assert events[0].reason == "evicted"
            assert scheduler._nodes[victim.node_id].state == SpotNodeState.EVICTED

            result = await manager.reconcile_once()
            assert result["replaced"] == 1
            assert result["created"] >= 1
            assert all(
                node.state == SpotNodeState.READY
                for node in scheduler._nodes.values()
            )
            assert len(scheduler._nodes) >= 2
            assert manager.snapshot()["metrics"]["evictions_total"] == 1
            assert manager.snapshot()["metrics"]["nodes_replaced_total"] == 1
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_heartbeat_detects_failure_and_records_failure_event():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=1, heartbeat_interval=60, reconcile_interval=60
        )
        await manager.start(background=False)
        try:
            victim = next(iter(scheduler._nodes.values()))
            provider.simulate_state(victim.node_id, SpotNodeState.FAILED, error="boot failure")
            events = await manager.heartbeat_once()
            assert len(events) == 1
            assert events[0].reason == "failed"
            assert manager.snapshot()["metrics"]["failures_total"] == 1
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_scale_for_creates_additional_nodes_within_max_nodes():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=1, max_nodes=3, heartbeat_interval=60, reconcile_interval=60
        )
        await manager.start(background=False)
        try:
            plan = await manager.scale_for(3)
            assert plan.target_nodes == 3
            ready = sum(
                1 for n in scheduler._nodes.values() if n.state == SpotNodeState.READY
            )
            assert ready == 3
            assert manager.snapshot()["metrics"]["scale_up_total"] >= 2
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_scale_for_respects_max_nodes_ceiling():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=2, max_nodes=2, heartbeat_interval=60, reconcile_interval=60
        )
        await manager.start(background=False)
        try:
            plan = await manager.scale_for(10)
            # Already at max_nodes — no additional create.
            assert plan.target_nodes == 2
            assert len(scheduler._nodes) == 2
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_background_loops_run_periodically_after_start():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=1, heartbeat_interval=0.02, reconcile_interval=0.02
        )
        await manager.start(background=True)
        try:
            # Give the background tasks several ticks.
            await asyncio.sleep(0.2)
            snap = manager.snapshot()
            assert snap["metrics"]["heartbeat_count"] >= 2
            assert snap["metrics"]["reconcile_count"] >= 2
            assert snap["metrics"]["heartbeat_failures"] == 0
            assert snap["metrics"]["reconcile_failures"] == 0
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_busy_node_state_is_preserved_across_heartbeat():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=2, heartbeat_interval=60, reconcile_interval=60
        )
        await manager.start(background=False)
        try:
            reservation = await manager.reserve(1, task_ids=["task-1"])
            assert reservation.assignments
            busy_id = next(iter(reservation.assignments.keys()))

            await manager.heartbeat_once()
            assert scheduler._nodes[busy_id].state == SpotNodeState.BUSY
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_manager_rejects_invalid_intervals():
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(
        provider=provider, config=SpotPoolConfig(min_ready=1, max_nodes=2)
    )
    with pytest.raises(ValueError):
        SpotPoolManager(scheduler=scheduler, heartbeat_interval=0)
    with pytest.raises(ValueError):
        SpotPoolManager(scheduler=scheduler, reconcile_interval=-1)


def test_manager_event_buffer_caps_recent_events_in_snapshot():
    async def scenario():
        provider, scheduler, manager = _build_manager(
            min_ready=1, max_nodes=2, event_buffer=5
        )
        await manager.start(background=False)
        try:
            # Trigger many records (heartbeat_once records one event per call).
            for _ in range(20):
                await manager.heartbeat_once()
            snap = manager.snapshot()
            recent = snap["recent_events"]
            assert len(recent) <= 5, (
                f"snapshot returned {len(recent)} events, expected <= event_buffer (5)"
            )
        finally:
            await manager.stop()

    asyncio.run(scenario())


def test_manager_rejects_invalid_event_buffer():
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(
        provider=provider, config=SpotPoolConfig(min_ready=1, max_nodes=2)
    )
    with pytest.raises(ValueError):
        SpotPoolManager(scheduler=scheduler, event_buffer=0)
