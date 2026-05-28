"""Background job tracker — user-visible record for long-running work.

Pool internals (heartbeat, reconcile, quota refresh) already record
audit events, but those are noisy and shaped for debugging. A
*background job* is the user-facing version: one row per logical task
(e.g. "scan quota across all Azure regions") with a clear started_at /
finished_at / status / result / error so the dashboard can answer
"what is the system doing right now?" without scrolling the audit log.

The registry is intentionally in-memory and bounded — it is an
observability surface, not a durable queue.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

from rapid_evidence.core.ids import new_id
from rapid_evidence.core.time import utc_now_iso


logger = logging.getLogger(__name__)


JobStatus = Literal["running", "succeeded", "failed", "cancelled"]


@dataclass
class BackgroundJob:
    job_id: str
    name: str
    started_at: str
    status: JobStatus = "running"
    finished_at: str | None = None
    duration_seconds: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "name": self.name,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_seconds": self.duration_seconds,
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "metadata": dict(self.metadata),
        }


class BackgroundJobRegistry:
    """Thread + asyncio safe bounded registry of recent background jobs."""

    def __init__(self, *, max_jobs: int = 100) -> None:
        if max_jobs <= 0:
            raise ValueError("max_jobs must be positive")
        self._max_jobs = max_jobs
        self._jobs: dict[str, BackgroundJob] = {}
        self._order: list[str] = []
        # `threading.Lock` so the registry is safe from both the FastAPI
        # event loop AND any `asyncio.to_thread` worker that wants to
        # update progress mid-flight.
        self._lock = threading.Lock()

    def start(self, name: str, *, metadata: dict[str, Any] | None = None) -> BackgroundJob:
        clean = (name or "").strip()
        if not clean:
            raise ValueError("BackgroundJob name must be non-empty")
        job = BackgroundJob(
            job_id=new_id("job"),
            name=clean,
            started_at=utc_now_iso(),
            metadata=dict(metadata or {}),
        )
        with self._lock:
            self._jobs[job.job_id] = job
            self._order.append(job.job_id)
            self._evict_locked()
        return job

    def finish(
        self,
        job_id: str,
        *,
        status: JobStatus,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> BackgroundJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.status = status
            job.finished_at = utc_now_iso()
            job.result = result
            job.error = error
            try:
                started = _parse_iso(job.started_at)
                finished = _parse_iso(job.finished_at)
                job.duration_seconds = max(0.0, (finished - started).total_seconds())
            except Exception:  # noqa: BLE001
                job.duration_seconds = None
            return job

    def update_metadata(self, job_id: str, patch: dict[str, Any]) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.metadata.update(patch)

    def get(self, job_id: str) -> BackgroundJob | None:
        """Return a *snapshot* copy so callers cannot mutate the registry's view."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return _snapshot(job)

    def list(self, *, limit: int = 50) -> list[BackgroundJob]:
        if limit <= 0:
            return []
        with self._lock:
            tail = self._order[-limit:]
            return [_snapshot(self._jobs[j]) for j in tail if j in self._jobs]

    def _evict_locked(self) -> None:
        overflow = len(self._order) - self._max_jobs
        if overflow <= 0:
            return
        evicted = self._order[:overflow]
        self._order = self._order[overflow:]
        for jid in evicted:
            removed = self._jobs.pop(jid, None)
            if removed is not None:
                logger.info(
                    "background job evicted from registry (capacity=%d): job_id=%s name=%s status=%s",
                    self._max_jobs,
                    removed.job_id,
                    removed.name,
                    removed.status,
                )


def _snapshot(job: BackgroundJob) -> BackgroundJob:
    return BackgroundJob(
        job_id=job.job_id,
        name=job.name,
        started_at=job.started_at,
        status=job.status,
        finished_at=job.finished_at,
        duration_seconds=job.duration_seconds,
        result=dict(job.result) if job.result is not None else None,
        error=job.error,
        metadata=dict(job.metadata),
    )


def _parse_iso(timestamp: str):
    from datetime import datetime

    return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))


async def run_tracked(
    registry: BackgroundJobRegistry,
    name: str,
    coro_factory,
    *,
    metadata: dict[str, Any] | None = None,
) -> tuple[BackgroundJob, Any]:
    """Run `coro_factory()` inside a tracked job.

    Returns the final `BackgroundJob` snapshot plus the awaited result
    (or None on failure). Captures any `Exception` as a `failed` job
    with `error=<str>` so callers do not need to wrap. `CancelledError`
    is recorded as `cancelled` and re-raised so the surrounding task
    can finish unwinding.
    """
    job = registry.start(name, metadata=metadata)
    try:
        coro = coro_factory()
        if asyncio.iscoroutine(coro):
            result = await coro
        else:
            # Allow callers to pass a sync function returning a value.
            result = await asyncio.to_thread(lambda: coro)
        registry.finish(job.job_id, status="succeeded", result=_coerce_result(result))
        return registry.get(job.job_id) or job, result
    except asyncio.CancelledError:
        registry.finish(job.job_id, status="cancelled", error="cancelled")
        raise
    except Exception as exc:  # noqa: BLE001
        registry.finish(job.job_id, status="failed", error=str(exc))
        return registry.get(job.job_id) or job, None


def _coerce_result(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        try:
            converted = to_dict()
            if isinstance(converted, dict):
                return converted
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "BackgroundJob result.to_dict() raised %s; falling back to repr",
                exc,
            )
    if isinstance(value, list):
        return {"items": value, "count": len(value)}
    return {"value": str(value)}
