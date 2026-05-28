"""In-process batch registry.

A `Batch` is a named group of `FetchRequest` items targeting a single source.
The registry tracks lifecycle (`queued -> running -> done|cancelled|failed`),
rolling throughput, and ETA, and exposes thread-safe progress snapshots that
the API layer can serve without touching internal locks.

This module intentionally implements *only* what the Throughput page needs:
batches run as asyncio tasks, sync source/sink calls are dispatched to a
thread pool, and per-batch worker concurrency is bounded by a semaphore.
Sharing the surge orchestrator's worker pool is out of scope here — the
batch executor is the unit of work the UI reasons about.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Protocol

from rapid_evidence.core.ids import new_id
from rapid_evidence.core.models import FetchRequest, FetchResult, RequestStatus
from rapid_evidence.core.time import utc_now_iso

logger = logging.getLogger(__name__)


# Rolling window (seconds) used to derive batch throughput and ETA.
_THROUGHPUT_WINDOW_SECONDS = 60.0

# Max history events kept per BatchRecord (FIFO). The detail-page timeline
# fetches the whole list, so cap it to bound memory regardless of batch size.
_HISTORY_MAX_EVENTS = 256


class BatchStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    PAUSED = "paused"
    DONE = "done"
    CANCELLED = "cancelled"
    FAILED = "failed"


class SourceClient(Protocol):
    def fetch(
        self, url: str, headers: dict[str, str] | None = ...
    ) -> dict[str, Any]: ...


class ResultSink(Protocol):
    def write(self, result: FetchResult) -> None: ...


@dataclass
class BatchProgress:
    batch_id: str
    source: str
    status: BatchStatus
    total: int
    completed: int
    failed: int
    workers_active: int
    workers_target: int
    throughput_per_second: float
    eta_seconds: float | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    error: str | None
    metadata: dict[str, Any]

    @property
    def pending(self) -> int:
        return max(0, self.total - self.completed - self.failed)

    @property
    def percent(self) -> float:
        if self.total == 0:
            return 100.0
        return round(((self.completed + self.failed) / self.total) * 100.0, 2)

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "source": self.source,
            "status": self.status.value,
            "total": self.total,
            "completed": self.completed,
            "failed": self.failed,
            "pending": self.pending,
            "percent": self.percent,
            "workers_active": self.workers_active,
            "workers_target": self.workers_target,
            "throughput_per_second": round(self.throughput_per_second, 3),
            "eta_seconds": round(self.eta_seconds, 1) if self.eta_seconds is not None else None,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "metadata": dict(self.metadata),
        }


@dataclass
class BatchRecord:
    batch_id: str
    source: str
    requests: list[FetchRequest]
    workers_target: int
    metadata: dict[str, Any] = field(default_factory=dict)
    status: BatchStatus = BatchStatus.QUEUED
    completed: int = 0
    failed: int = 0
    workers_active: int = 0
    created_at: str = field(default_factory=utc_now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    # Count of in-flight requests requeued after a spot-node eviction,
    # observed via SpotPoolManager.drain_eviction_events. Surfaced in
    # BatchProgress.metadata["evictions_observed"] so the UI can flag
    # batches that hit instability.
    evictions_observed: int = 0
    # Per-node dispatch counts (node_id -> count of successful fetches),
    # surfaced in BatchProgress.metadata["node_counts"] so the UI can
    # show which Spot VM handled how many requests.
    node_counts: dict[str, int] = field(default_factory=dict)
    # Request IDs that were requeued at least once due to eviction;
    # surfaced via BatchProgress.metadata["evicted_request_ids"]. Capped
    # at the same FIFO limit as `history` to bound memory on long batches.
    evicted_request_ids: list[str] = field(default_factory=list)
    # Append-only event log surfaced via GET /batches/{id}/timeline.
    # Capped FIFO; oldest events drop when over the limit.
    history: list[dict[str, Any]] = field(default_factory=list)
    # Monotonic timestamps of completed-or-failed requests, for throughput.
    _completion_log: deque[float] = field(default_factory=deque, repr=False)
    _task: asyncio.Task[None] | None = field(default=None, repr=False)
    _cancel_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def total(self) -> int:
        return len(self.requests)

    def record_completion(self, *, success: bool) -> None:
        now = time.monotonic()
        if success:
            self.completed += 1
        else:
            self.failed += 1
        self._completion_log.append(now)
        self._trim_completion_log(now)

    def _trim_completion_log(self, now: float) -> None:
        cutoff = now - _THROUGHPUT_WINDOW_SECONDS
        while self._completion_log and self._completion_log[0] < cutoff:
            self._completion_log.popleft()

    def record_event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.history.append(
            {
                "timestamp": utc_now_iso(),
                "event_type": event_type,
                "payload": dict(payload or {}),
            }
        )
        overflow = len(self.history) - _HISTORY_MAX_EVENTS
        if overflow > 0:
            del self.history[:overflow]

    def throughput_per_second(self) -> float:
        now = time.monotonic()
        self._trim_completion_log(now)
        if not self._completion_log:
            return 0.0
        # Use the actual span covered by samples to avoid lowballing fresh batches.
        span = max(now - self._completion_log[0], 1.0)
        return len(self._completion_log) / span

    def eta_seconds(self) -> float | None:
        pending = max(0, self.total - self.completed - self.failed)
        if pending == 0:
            return 0.0
        rate = self.throughput_per_second()
        if rate <= 0:
            return None
        return pending / rate

    def progress(self) -> BatchProgress:
        meta = dict(self.metadata)
        if self.evictions_observed:
            meta["evictions_observed"] = self.evictions_observed
        if self.node_counts:
            meta["node_counts"] = dict(self.node_counts)
        if self.evicted_request_ids:
            meta["evicted_request_ids"] = list(self.evicted_request_ids)
        return BatchProgress(
            batch_id=self.batch_id,
            source=self.source,
            status=self.status,
            total=self.total,
            completed=self.completed,
            failed=self.failed,
            workers_active=self.workers_active,
            workers_target=self.workers_target,
            throughput_per_second=self.throughput_per_second(),
            eta_seconds=self.eta_seconds(),
            created_at=self.created_at,
            started_at=self.started_at,
            finished_at=self.finished_at,
            error=self.error,
            metadata=meta,
        )


class BatchExecutor:
    """Runs a single BatchRecord, honouring cancellation and worker bounds."""

    def __init__(
        self,
        source_client: SourceClient,
        sink: ResultSink,
        *,
        request_timeout_seconds: float = 60.0,
    ) -> None:
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        self.source_client = source_client
        self.sink = sink
        self.request_timeout_seconds = request_timeout_seconds

    async def run(self, record: BatchRecord) -> None:
        record.status = BatchStatus.RUNNING
        record.started_at = utc_now_iso()
        record.record_event(
            "started",
            {"workers_target": record.workers_target, "total": record.total},
        )
        sem = asyncio.Semaphore(max(1, record.workers_target))
        active_lock = asyncio.Lock()

        async def process(req: FetchRequest) -> None:
            if record._cancel_event.is_set():
                return
            async with sem:
                if record._cancel_event.is_set():
                    return
                async with active_lock:
                    record.workers_active += 1
                try:
                    await self._process_one(record, req)
                finally:
                    async with active_lock:
                        record.workers_active -= 1

        tasks = [asyncio.create_task(process(req)) for req in record.requests]
        try:
            await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            record.finished_at = utc_now_iso()
            if record._cancel_event.is_set() and record.status not in (
                BatchStatus.DONE,
                BatchStatus.FAILED,
            ):
                record.status = BatchStatus.CANCELLED
            elif record.failed and record.completed == 0:
                record.status = BatchStatus.FAILED
            else:
                record.status = BatchStatus.DONE
            record.record_event(
                "finished",
                {
                    "status": record.status.value,
                    "completed": record.completed,
                    "failed": record.failed,
                },
            )

    async def _process_one(self, record: BatchRecord, req: FetchRequest) -> None:
        try:
            fetched = await asyncio.wait_for(
                self._invoke_source(req),
                timeout=self.request_timeout_seconds,
            )
            body = fetched.get("body", b"") if isinstance(fetched, dict) else b""
            status_code = fetched.get("status") if isinstance(fetched, dict) else None
            metrics: dict[str, Any] = {
                "bytes": len(body) if isinstance(body, (bytes, bytearray)) else 0,
                "status_code": status_code,
            }
            if isinstance(fetched, dict):
                for key in ("outbound_ip", "node_id", "attempts"):
                    if fetched.get(key) is not None:
                        metrics[key] = fetched[key]
                node_id = fetched.get("node_id")
                if isinstance(node_id, str) and node_id:
                    record.node_counts[node_id] = (
                        record.node_counts.get(node_id, 0) + 1
                    )
            result = FetchResult(
                request_id=req.request_id,
                source=req.source,
                target=req.target,
                status=RequestStatus.SUCCEEDED,
                body=body if isinstance(body, (bytes, bytearray)) else b"",
                metrics=metrics,
            )
            await asyncio.to_thread(self.sink.write, result)
            record.record_completion(success=True)
        except Exception as exc:  # noqa: BLE001
            result = FetchResult(
                request_id=req.request_id,
                source=req.source,
                target=req.target,
                status=RequestStatus.FAILED,
                body=b"",
                metrics={"bytes": 0},
                error=str(exc),
            )
            try:
                await asyncio.to_thread(self.sink.write, result)
            except Exception as sink_exc:  # noqa: BLE001
                logger.warning("sink rejected failure result: %s", sink_exc)
            record.record_completion(success=False)

    async def _invoke_source(self, req: FetchRequest):
        """Dispatch a single fetch via whichever source flavour we have.

        Async sources expose `fetch_async(url, headers, *, request_id=)`
        (preferred — RemoteWorkerSource) OR a coroutine `fetch(url,
        headers)`. Sync sources expose a plain `fetch(url, headers)` and
        are dispatched via a worker thread.
        """
        async_fetch = getattr(self.source_client, "fetch_async", None)
        if async_fetch is not None and inspect.iscoroutinefunction(async_fetch):
            try:
                return await async_fetch(
                    req.target, req.headers, request_id=req.request_id
                )
            except TypeError:
                return await async_fetch(req.target, req.headers)
        fetch = self.source_client.fetch
        if inspect.iscoroutinefunction(fetch):
            return await fetch(req.target, req.headers)
        return await asyncio.to_thread(fetch, req.target, req.headers)


class BatchRegistry:
    """Tracks batches and exposes aggregate throughput / backlog.

    The registry never blocks the event loop: writes happen from the
    executor coroutine, snapshot reads only touch dataclasses. A single
    `asyncio.Lock` serialises map mutations (submit / cancel) so that
    concurrent API calls do not race on the dict.
    """

    def __init__(
        self,
        executor_factory: Callable[[str], BatchExecutor],
        *,
        default_workers: int = 4,
    ) -> None:
        if default_workers <= 0:
            raise ValueError("default_workers must be positive")
        self.executor_factory = executor_factory
        self.default_workers = default_workers
        self._records: dict[str, BatchRecord] = {}
        # request_id -> batch_id; lets `notify_eviction` route requeue
        # hints from the SpotPoolManager to the right BatchRecord.
        self._request_index: dict[str, str] = {}
        # Tracks the most recent N completions across ALL batches, for
        # aggregate throughput reporting on the dashboard.
        self._global_completions: deque[float] = deque(maxlen=10000)
        self._lock = asyncio.Lock()

    async def submit(
        self,
        *,
        source: str,
        targets: list[str],
        workers: int | None = None,
        headers: dict[str, str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> BatchRecord:
        if not source.strip():
            raise ValueError("source is required")
        if not targets:
            raise ValueError("targets must not be empty")
        normalized_source = source.strip().lower()
        request_headers = headers or {"User-Agent": "rapid-evidence"}
        requests = [
            FetchRequest(target=t, source=normalized_source, headers=dict(request_headers))
            for t in targets
            if t.strip()
        ]
        if not requests:
            raise ValueError("targets must contain at least one non-empty url")
        record = BatchRecord(
            batch_id=new_id("batch"),
            source=normalized_source,
            requests=requests,
            workers_target=max(1, workers or self.default_workers),
            metadata=dict(metadata or {}),
        )
        record.record_event(
            "queued",
            {"source": normalized_source, "total": len(requests)},
        )
        async with self._lock:
            self._records[record.batch_id] = record
            for req in record.requests:
                self._request_index[req.request_id] = record.batch_id
        record._task = asyncio.create_task(
            self._run_and_track(record), name=f"batch-{record.batch_id}"
        )
        return record

    async def _run_and_track(self, record: BatchRecord) -> None:
        executor = self.executor_factory(record.source)
        # Patch the executor's record_completion to also push to the
        # global log without leaking BatchRegistry into BatchRecord.
        original = record.record_completion

        def tracked(success: bool) -> None:
            original(success=success)
            self._global_completions.append(time.monotonic())

        record.record_completion = tracked  # type: ignore[assignment]
        try:
            await executor.run(record)
        except asyncio.CancelledError:
            record.status = BatchStatus.CANCELLED
            record.finished_at = utc_now_iso()
            raise
        except Exception as exc:  # noqa: BLE001
            record.status = BatchStatus.FAILED
            record.error = str(exc)
            record.finished_at = utc_now_iso()

    def get(self, batch_id: str) -> BatchRecord | None:
        return self._records.get(batch_id)

    def progress(self, batch_id: str) -> BatchProgress | None:
        record = self._records.get(batch_id)
        return record.progress() if record else None

    def list_progress(self) -> list[BatchProgress]:
        # Newest first; UI sorts by status separately when it wants.
        records = sorted(
            self._records.values(), key=lambda r: r.created_at, reverse=True
        )
        return [r.progress() for r in records]

    def notify_eviction(
        self, *, requeue_task_ids: tuple[str, ...] | list[str], reason: str
    ) -> dict[str, int]:
        """Record a spot-node eviction touching the given request IDs.

        The RemoteWorkerSource retries the actual fetch on a different
        node, so this is informational: it bumps each affected batch's
        `evictions_observed` counter so the UI can flag instability.
        Returns a `{batch_id: count}` map of which batches were affected.
        """
        affected: dict[str, int] = {}
        per_batch_requests: dict[str, list[str]] = {}
        for request_id in requeue_task_ids:
            batch_id = self._request_index.get(request_id)
            if not batch_id:
                continue
            record = self._records.get(batch_id)
            if record is None:
                continue
            record.evictions_observed += 1
            affected[batch_id] = affected.get(batch_id, 0) + 1
            per_batch_requests.setdefault(batch_id, []).append(request_id)
        for batch_id, request_ids in per_batch_requests.items():
            record = self._records[batch_id]
            record.record_event(
                "evicted",
                {"reason": reason, "request_ids": list(request_ids)},
            )
            for rid in request_ids:
                if rid not in record.evicted_request_ids:
                    record.evicted_request_ids.append(rid)
            overflow = len(record.evicted_request_ids) - _HISTORY_MAX_EVENTS
            if overflow > 0:
                del record.evicted_request_ids[:overflow]
        if affected:
            logger.info(
                "eviction (%s) requeued %d request(s) across %d batch(es)",
                reason,
                sum(affected.values()),
                len(affected),
            )
        return affected

    async def cancel(self, batch_id: str) -> BatchProgress | None:
        record = self._records.get(batch_id)
        if record is None:
            return None
        record.record_event("cancel_requested", {})
        record._cancel_event.set()
        if record._task is not None and not record._task.done():
            record._task.cancel()
            try:
                await record._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        return record.progress()

    async def stop_all(self) -> None:
        async with self._lock:
            records = list(self._records.values())
        for record in records:
            record._cancel_event.set()
            if record._task is not None and not record._task.done():
                record._task.cancel()
        for record in records:
            if record._task is not None:
                try:
                    await record._task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    # ----- aggregate dashboard metrics ------------------------------

    def backlog(self) -> int:
        return sum(
            max(0, r.total - r.completed - r.failed)
            for r in self._records.values()
            if r.status in (BatchStatus.QUEUED, BatchStatus.RUNNING, BatchStatus.PAUSED)
        )

    def active_batch_count(self) -> int:
        return sum(
            1
            for r in self._records.values()
            if r.status in (BatchStatus.QUEUED, BatchStatus.RUNNING, BatchStatus.PAUSED)
        )

    def aggregate_throughput_per_second(self) -> float:
        now = time.monotonic()
        cutoff = now - _THROUGHPUT_WINDOW_SECONDS
        while self._global_completions and self._global_completions[0] < cutoff:
            self._global_completions.popleft()
        if not self._global_completions:
            return 0.0
        span = max(now - self._global_completions[0], 1.0)
        return len(self._global_completions) / span

    def drain_eta_seconds(self) -> float | None:
        backlog = self.backlog()
        if backlog == 0:
            return 0.0
        rate = self.aggregate_throughput_per_second()
        if rate <= 0:
            return None
        return backlog / rate
