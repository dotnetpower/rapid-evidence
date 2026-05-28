from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from rapid_evidence.core.time import utc_now_iso
from rapid_evidence.spot.models import (
    EvictionEvent,
    QuotaSnapshot,
    SpotCapacityPlan,
    SpotNode,
    SpotNodeState,
    SpotReservation,
)
from rapid_evidence.spot.scheduler import SpotVmScheduler
from rapid_evidence.spot.sizing import estimate_spot_capacity


logger = logging.getLogger(__name__)


_TRANSIENT_NODE_STATES = frozenset(
    {SpotNodeState.BUSY, SpotNodeState.DRAINING, SpotNodeState.PROVISIONING}
)
_AUTHORITATIVE_PROVIDER_STATES = frozenset(
    {SpotNodeState.EVICTED, SpotNodeState.FAILED}
)
_DEAD_STATES = frozenset({SpotNodeState.EVICTED, SpotNodeState.FAILED})


@dataclass
class PoolEvent:
    event_type: str
    timestamp: str
    payload: dict[str, Any]


@dataclass
class PoolCounters:
    ready: int = 0
    busy: int = 0
    provisioning: int = 0
    terminating: int = 0
    evicted: int = 0
    failed: int = 0
    terminated: int = 0
    draining: int = 0


@dataclass
class PoolMetrics:
    heartbeat_count: int = 0
    heartbeat_failures: int = 0
    last_heartbeat_at: str | None = None
    reconcile_count: int = 0
    reconcile_failures: int = 0
    last_reconcile_at: str | None = None
    evictions_total: int = 0
    failures_total: int = 0
    nodes_created_total: int = 0
    nodes_replaced_total: int = 0
    nodes_terminated_total: int = 0
    scale_up_total: int = 0
    scale_down_total: int = 0


class SpotPoolManager:
    """Long-running orchestrator for a Spot VM pool.

    Owns the lifecycle of a `SpotVmScheduler`:

    1. **start()** warms the pool to `min_ready` and launches the heartbeat
       and reconcile background tasks.
    2. **heartbeat loop** polls the provider every `heartbeat_interval`
       seconds and merges fresh provider state with locally-tracked busy
       work, detecting evictions/failures as transitions.
    3. **reconcile loop** every `reconcile_interval` seconds removes dead
       nodes (evicted/failed), records requeue payloads, then re-warms
       the pool to `min_ready` via the scheduler.
    4. **scale_for(n)** computes a capacity plan and synchronously asks
       the provider to scale up (bounded by `max_nodes`).
    5. **stop()** cancels the background tasks and terminates every node
       via the provider.

    Sync provider calls are dispatched via `asyncio.to_thread` so the
    FastAPI event loop is never blocked by `az` CLI subprocess calls.
    """

    def __init__(
        self,
        scheduler: SpotVmScheduler,
        *,
        heartbeat_interval: float = 15.0,
        reconcile_interval: float = 30.0,
        event_buffer: int = 200,
        audit_sink=None,
        provider_lock: asyncio.Lock | None = None,
    ) -> None:
        if heartbeat_interval <= 0:
            raise ValueError("heartbeat_interval must be positive")
        if reconcile_interval <= 0:
            raise ValueError("reconcile_interval must be positive")
        if event_buffer <= 0:
            raise ValueError("event_buffer must be positive")
        self.scheduler = scheduler
        self.heartbeat_interval = heartbeat_interval
        self.reconcile_interval = reconcile_interval
        self.audit_sink = audit_sink
        self._event_buffer = event_buffer
        self._events: list[PoolEvent] = []
        self._metrics = PoolMetrics()
        self._eviction_events: list[EvictionEvent] = []
        # Separate, never-drained observability ring buffer so that
        # `snapshot()` can still surface recent evictions even when a
        # background drain task is consuming `_eviction_events`.
        self._eviction_history: list[EvictionEvent] = []
        # Last observed provider quota, populated by future quota probe.
        # Surfaced via snapshot()["quota"] for the dashboard /quota page.
        self._last_quota: QuotaSnapshot | None = None
        self._running = False
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._reconcile_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        # Serialises provider mutations (create/terminate/refresh) so that
        # heartbeat, reconcile, and scale_for never race on the underlying
        # subprocess provider.
        self._provider_lock = provider_lock or asyncio.Lock()

    # ----- lifecycle ----------------------------------------------------

    @property
    def running(self) -> bool:
        return self._running

    async def start(self, *, background: bool = True) -> None:
        async with self._lock:
            if self._running:
                return
            await self._warm_pool_locked()
            self._running = True
            if background:
                self._heartbeat_task = asyncio.create_task(
                    self._heartbeat_loop(), name="rapid-evidence-spot-heartbeat"
                )
                self._reconcile_task = asyncio.create_task(
                    self._reconcile_loop(), name="rapid-evidence-spot-reconcile"
                )
            self._record(
                "pool_started",
                {
                    "min_ready": self.scheduler.config.min_ready,
                    "max_nodes": self.scheduler.config.max_nodes,
                    "per_node_concurrency": self.scheduler.config.per_node_concurrency,
                    "heartbeat_interval_seconds": self.heartbeat_interval,
                    "reconcile_interval_seconds": self.reconcile_interval,
                    "provider": getattr(self.scheduler.provider, "provider_name", "unknown"),
                    "background_tasks": background,
                },
            )

    async def stop(self) -> None:
        async with self._lock:
            if not self._running:
                return
            self._running = False
            tasks = [t for t in (self._heartbeat_task, self._reconcile_task) if t is not None]
            for task in tasks:
                task.cancel()
            for task in tasks:
                try:
                    await task
                except (asyncio.CancelledError, Exception) as exc:  # noqa: BLE001
                    if not isinstance(exc, asyncio.CancelledError):
                        logger.warning("background task ended with error: %s", exc)
            self._heartbeat_task = None
            self._reconcile_task = None
            try:
                async with self._provider_lock:
                    terminated_count = len(
                        [n for n in self.scheduler._nodes.values() if n.state != SpotNodeState.TERMINATED]
                    )
                    await asyncio.to_thread(self.scheduler.cleanup_all)
                self._metrics.nodes_terminated_total += terminated_count
            except Exception as exc:  # noqa: BLE001
                logger.warning("cleanup_all failed during stop: %s", exc)
                self._record("pool_cleanup_failed", {"error": str(exc)})
            self._record("pool_stopped", self._counters_dict())

    async def _warm_pool_locked(self) -> None:
        async with self._provider_lock:
            before = len(self.scheduler._nodes)
            await asyncio.to_thread(self.scheduler.initialize)
            after = len(self.scheduler._nodes)
        created = max(0, after - before)
        self._metrics.nodes_created_total += created
        self._record(
            "pool_warmed",
            {
                "initial_nodes": before,
                "current_nodes": after,
                "created": created,
                "min_ready": self.scheduler.config.min_ready,
            },
        )

    # ----- heartbeat / reconcile ---------------------------------------

    async def _heartbeat_loop(self) -> None:
        while self._running:
            try:
                await self.heartbeat_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._metrics.heartbeat_failures += 1
                self._record("heartbeat_failed", {"error": str(exc)})
            try:
                await asyncio.sleep(self.heartbeat_interval)
            except asyncio.CancelledError:
                raise

    async def _reconcile_loop(self) -> None:
        while self._running:
            try:
                await self.reconcile_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self._metrics.reconcile_failures += 1
                self._record("reconcile_failed", {"error": str(exc)})
            try:
                await asyncio.sleep(self.reconcile_interval)
            except asyncio.CancelledError:
                raise

    async def heartbeat_once(self) -> list[EvictionEvent]:
        """Refresh provider view and merge with locally tracked work.

        Returns the list of new eviction events detected during this beat.
        Detects EVICTED/FAILED transitions and stages them for the
        reconcile loop. BUSY/DRAINING/PROVISIONING in the scheduler view
        are preserved unless the provider says the node has died.
        """
        async with self._provider_lock:
            fresh_nodes = await asyncio.to_thread(self.scheduler.provider.refresh_nodes)
        events, transitions = self._merge_provider_view(tuple(fresh_nodes))
        self._metrics.heartbeat_count += 1
        self._metrics.last_heartbeat_at = utc_now_iso()
        self._metrics.evictions_total += sum(1 for e in events if e.reason == "evicted")
        self._metrics.failures_total += sum(1 for e in events if e.reason == "failed")
        if events:
            self._eviction_events.extend(events)
            # Cap eviction buffer so a long-running pool does not leak.
            overflow = len(self._eviction_events) - self._event_buffer
            if overflow > 0:
                del self._eviction_events[:overflow]
            # Observability history is independent of the drain buffer.
            self._eviction_history.extend(events)
            hist_overflow = len(self._eviction_history) - self._event_buffer
            if hist_overflow > 0:
                del self._eviction_history[:hist_overflow]
        self._record(
            "heartbeat",
            {
                "count": self._metrics.heartbeat_count,
                "node_count": len(self.scheduler._nodes),
                "new_evictions": len(events),
                "transitions": transitions,
            },
        )
        return events

    def _merge_provider_view(
        self, fresh_nodes: tuple[SpotNode, ...]
    ) -> tuple[list[EvictionEvent], list[dict[str, str]]]:
        events: list[EvictionEvent] = []
        transitions: list[dict[str, str]] = []
        fresh_by_id = {node.node_id: node for node in fresh_nodes}
        prev_nodes = dict(self.scheduler._nodes)
        merged: dict[str, SpotNode] = {}

        for node_id, fresh in fresh_by_id.items():
            prev = prev_nodes.get(node_id)
            if fresh.state == SpotNodeState.TERMINATED:
                # Provider sees a terminated node — drop it from the local
                # view so reconcile is not forced to re-prune on every beat.
                if prev is not None and prev.state != SpotNodeState.TERMINATED:
                    transitions.append(
                        {
                            "node_id": node_id,
                            "from": prev.state.value,
                            "to": fresh.state.value,
                        }
                    )
                continue
            if fresh.state in _AUTHORITATIVE_PROVIDER_STATES:
                merged[node_id] = fresh
                if prev is None or prev.state != fresh.state:
                    reason = "evicted" if fresh.state == SpotNodeState.EVICTED else "failed"
                    events.append(
                        EvictionEvent(
                            node_id=node_id,
                            public_ip=prev.public_ip if prev else fresh.public_ip,
                            reason=reason,
                            requeue_task_ids=tuple(
                                self.scheduler._assignments.get(node_id, ())
                            ),
                        )
                    )
                    transitions.append(
                        {
                            "node_id": node_id,
                            "from": prev.state.value if prev else "unknown",
                            "to": fresh.state.value,
                        }
                    )
                continue

            if prev is not None and prev.state in _TRANSIENT_NODE_STATES:
                # Preserve locally-tracked transient state (busy/draining/provisioning).
                merged[node_id] = prev
                if prev.public_ip != fresh.public_ip and fresh.public_ip:
                    merged[node_id] = SpotNode(
                        node_id=prev.node_id,
                        name=prev.name,
                        state=prev.state,
                        public_ip=fresh.public_ip,
                        outbound_ip=fresh.outbound_ip or prev.outbound_ip,
                        inflight=prev.inflight,
                        vm_size=prev.vm_size,
                        zone=prev.zone,
                        metadata=prev.metadata,
                        error=prev.error,
                    )
                continue

            merged[node_id] = fresh
            if prev is not None and prev.state != fresh.state:
                transitions.append(
                    {
                        "node_id": node_id,
                        "from": prev.state.value,
                        "to": fresh.state.value,
                    }
                )

        # Keep busy / draining nodes that the provider no longer reports
        # (e.g. eventual consistency in `az vm list`). They will be
        # reconciled on the next beat.
        for node_id, prev in prev_nodes.items():
            if node_id in merged:
                continue
            if prev.state in {SpotNodeState.BUSY, SpotNodeState.DRAINING}:
                merged[node_id] = prev

        self.scheduler._nodes = merged
        return events, transitions

    async def reconcile_once(self) -> dict[str, int]:
        """Replace dead nodes and ensure `min_ready` is honoured."""
        async with self._provider_lock:
            dead_ids = tuple(
                node.node_id
                for node in self.scheduler._nodes.values()
                if node.state in _DEAD_STATES
            )
            replaced = 0
            if dead_ids:
                await asyncio.to_thread(self.scheduler.provider.terminate_nodes, dead_ids)
                for node_id in dead_ids:
                    self.scheduler._nodes.pop(node_id, None)
                    self.scheduler._assignments.pop(node_id, None)
                replaced = len(dead_ids)
            before = len(self.scheduler._nodes)
            await asyncio.to_thread(self.scheduler.ensure_min_ready)
            after = len(self.scheduler._nodes)
            created = max(0, after - before)
        self._metrics.reconcile_count += 1
        self._metrics.last_reconcile_at = utc_now_iso()
        self._metrics.nodes_replaced_total += replaced
        self._metrics.nodes_created_total += created
        result = {"replaced": replaced, "created": created, "node_count": after}
        self._record("reconcile", {"count": self._metrics.reconcile_count, **result})
        return result

    # ----- scaling / reservation ---------------------------------------

    async def scale_for(self, requested_tasks: int) -> SpotCapacityPlan:
        if requested_tasks < 0:
            raise ValueError("requested_tasks must be non-negative")
        async with self._provider_lock:
            ready_nodes = sum(
                1 for node in self.scheduler._nodes.values() if node.ready
            )
            active_nodes = sum(
                1
                for node in self.scheduler._nodes.values()
                if node.state
                in {
                    SpotNodeState.READY,
                    SpotNodeState.BUSY,
                    SpotNodeState.PROVISIONING,
                    SpotNodeState.DRAINING,
                }
            )
            plan = estimate_spot_capacity(
                self.scheduler.config,
                requested_tasks,
                ready_nodes,
                active_nodes,
                {},
            )
            headroom = max(0, self.scheduler.config.max_nodes - active_nodes)
            to_create = min(plan.scale_up_nodes, headroom)
            created_nodes: tuple[SpotNode, ...] = ()
            if to_create > 0:
                created_nodes = await asyncio.to_thread(
                    self.scheduler.provider.create_nodes, to_create, self.scheduler.config
                )
                for node in created_nodes:
                    self.scheduler._nodes[node.node_id] = node
                self._metrics.nodes_created_total += len(created_nodes)
                self._metrics.scale_up_total += len(created_nodes)
        if created_nodes or plan.scale_up_nodes:
            self._record(
                "scale_up",
                {
                    "requested_tasks": requested_tasks,
                    "plan_scale_up": plan.scale_up_nodes,
                    "actually_created": len(created_nodes),
                    "max_nodes": self.scheduler.config.max_nodes,
                },
            )
        return plan

    async def reserve(
        self, requested_tasks: int, task_ids: list[str] | None = None
    ) -> SpotReservation:
        async with self._provider_lock:
            reservation = await asyncio.to_thread(
                self.scheduler.reserve, requested_tasks, task_ids
            )
        self._record(
            "reserve",
            {
                "requested": requested_tasks,
                "assigned": len(reservation.assignments),
                "unassigned": len(reservation.unassigned_task_ids),
            },
        )
        return reservation

    async def release(self, node_ids: tuple[str, ...]) -> None:
        async with self._provider_lock:
            await asyncio.to_thread(self.scheduler.release, node_ids)
        self._record("release", {"node_ids": list(node_ids)})

    # ----- node introspection / fault injection ------------------------

    def get_node(self, node_id: str) -> SpotNode | None:
        """Return the local view of a node, or None if it is not tracked."""
        return self.scheduler._nodes.get(node_id)

    async def mark_node_failed(self, node_id: str, reason: str) -> None:
        """Mark a node FAILED so the reconcile loop will replace it.

        Called by `RemoteWorkerSource` after a dispatch fails because
        the node is unreachable / agent is dead. Does NOT terminate the
        VM here — the reconcile loop owns terminate + replace so we
        funnel all provider mutations through one place.
        """
        async with self._provider_lock:
            node = self.scheduler._nodes.get(node_id)
            if node is None:
                return
            failed = SpotNode(
                node_id=node.node_id,
                name=node.name,
                state=SpotNodeState.FAILED,
                public_ip=node.public_ip,
                outbound_ip=node.outbound_ip,
                inflight=0,
                vm_size=node.vm_size,
                zone=node.zone,
                metadata=node.metadata,
                error=reason,
            )
            self.scheduler._nodes[node_id] = failed
            self.scheduler._assignments.pop(node_id, None)
        self._metrics.failures_total += 1
        self._record(
            "node_failed_locally",
            {"node_id": node_id, "reason": reason},
        )

    # ----- snapshot / introspection ------------------------------------

    def snapshot(self) -> dict[str, Any]:
        counters = self._counters_dict()
        nodes = [
            {
                "node_id": node.node_id,
                "name": node.name,
                "state": node.state.value,
                "public_ip": node.public_ip,
                "outbound_ip": node.outbound_ip,
                "inflight": node.inflight,
                "vm_size": node.vm_size,
                "zone": node.zone,
                "metadata": dict(node.metadata),
                "error": node.error,
            }
            for node in self.scheduler._nodes.values()
        ]
        return {
            "running": self._running,
            "provider": getattr(self.scheduler.provider, "provider_name", "unknown"),
            "config": {
                "min_ready": self.scheduler.config.min_ready,
                "max_nodes": self.scheduler.config.max_nodes,
                "per_node_concurrency": self.scheduler.config.per_node_concurrency,
                "idle_timeout_seconds": self.scheduler.config.idle_timeout_seconds,
            },
            "intervals": {
                "heartbeat_seconds": self.heartbeat_interval,
                "reconcile_seconds": self.reconcile_interval,
            },
            "nodes": nodes,
            "counters": counters,
            "metrics": self._metrics_dict(),
            "quota": self._last_quota_dict(),
            "recent_evictions": [
                {
                    "node_id": e.node_id,
                    "public_ip": e.public_ip,
                    "reason": e.reason,
                    "requeue_task_ids": list(e.requeue_task_ids),
                }
                for e in self._eviction_history[-20:]
            ],
            "recent_events": [
                {"event_type": e.event_type, "timestamp": e.timestamp, "payload": e.payload}
                for e in self._events[-20:]
            ],
        }

    def _last_quota_dict(self) -> dict[str, Any] | None:
        quota = self._last_quota
        if quota is None:
            return None
        return {
            "used": quota.used,
            "limit": quota.limit,
            "spot_quota_observed": quota.spot_quota_observed,
            "public_ip_quota_observed": quota.public_ip_quota_observed,
            "is_sufficient": quota.is_sufficient,
        }

    def drain_eviction_events(self) -> list[EvictionEvent]:
        events = list(self._eviction_events)
        self._eviction_events.clear()
        return events

    def _counters_dict(self) -> dict[str, int]:
        counters = PoolCounters()
        for node in self.scheduler._nodes.values():
            state_name = node.state.value
            current = getattr(counters, state_name, None)
            if current is not None:
                setattr(counters, state_name, current + 1)
        return counters.__dict__

    def _metrics_dict(self) -> dict[str, Any]:
        return self._metrics.__dict__.copy()

    def _record(self, event_type: str, payload: dict[str, Any]) -> None:
        event = PoolEvent(
            event_type=event_type, timestamp=utc_now_iso(), payload=dict(payload)
        )
        self._events.append(event)
        overflow = len(self._events) - self._event_buffer
        if overflow > 0:
            del self._events[:overflow]
        if self.audit_sink is not None:
            try:
                self.audit_sink.record(event_type, payload)
            except Exception as exc:  # noqa: BLE001
                logger.warning("audit sink rejected event %s: %s", event_type, exc)
