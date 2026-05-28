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
            metadata=dict(self.metadata),
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

    async def _process_one(self, record: BatchRecord, req: FetchRequest) -> None:
        try:
            fetched = await asyncio.wait_for(
                asyncio.to_thread(self.source_client.fetch, req.target, req.headers),
                timeout=self.request_timeout_seconds,
            )
            body = fetched.get("body", b"") if isinstance(fetched, dict) else b""
            status_code = fetched.get("status") if isinstance(fetched, dict) else None
            result = FetchResult(
                request_id=req.request_id,
                source=req.source,
                target=req.target,
                status=RequestStatus.SUCCEEDED,
                body=body,
                metrics={"bytes": len(body), "status_code": status_code},
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
        async with self._lock:
            self._records[record.batch_id] = record
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

    async def cancel(self, batch_id: str) -> BatchProgress | None:
        record = self._records.get(batch_id)
        if record is None:
            return None
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
