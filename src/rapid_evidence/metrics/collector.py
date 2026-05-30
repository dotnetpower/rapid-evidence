"""Bounded ring buffer time-series collector for the dashboard.

`MetricsCollector` periodically calls a snapshot function and stores the
returned `MetricSample` in a deque. The deque length is bounded so a long
running pool cannot leak memory.

The dashboard reads via `query(window_seconds)` which returns the slice
covering the last N seconds. No I/O happens in the read path.
"""

from __future__ import annotations

import asyncio
import bisect
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Awaitable, Callable

from rapid_evidence.core.time import utc_now_iso

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MetricSample:
    timestamp: str  # RFC 3339
    monotonic: float  # internal use for windowed queries
    backlog: int
    throughput_per_second: float
    active_vms: int
    ready_vms: int
    running_vms: int
    provisioning_vms: int
    draining_vms: int
    active_batches: int

    def to_dict(self) -> dict[str, object]:
        return {
            "timestamp": self.timestamp,
            "backlog": self.backlog,
            "throughput_per_second": round(self.throughput_per_second, 3),
            "active_vms": self.active_vms,
            "ready_vms": self.ready_vms,
            "running_vms": self.running_vms,
            "provisioning_vms": self.provisioning_vms,
            "draining_vms": self.draining_vms,
            "active_batches": self.active_batches,
        }


SnapshotProducer = Callable[[], MetricSample | Awaitable[MetricSample]]


class MetricsCollector:
    def __init__(
        self,
        snapshot: SnapshotProducer,
        *,
        sample_interval_seconds: float = 5.0,
        retention_seconds: float = 3600.0,
    ) -> None:
        if sample_interval_seconds <= 0:
            raise ValueError("sample_interval_seconds must be positive")
        if retention_seconds <= 0:
            raise ValueError("retention_seconds must be positive")
        self.snapshot = snapshot
        self.sample_interval_seconds = sample_interval_seconds
        self.retention_seconds = retention_seconds
        maxlen = max(2, int(retention_seconds / sample_interval_seconds) + 2)
        self._samples: deque[MetricSample] = deque(maxlen=maxlen)
        self._task: asyncio.Task[None] | None = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        # Capture an initial sample so the dashboard has data on first paint.
        await self._take_sample()
        self._task = asyncio.create_task(self._loop(), name="rapid-evidence-metrics")

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.sample_interval_seconds)
            except asyncio.CancelledError:
                raise
            if not self._running:
                break
            try:
                await self._take_sample()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("metrics snapshot failed: %s", exc)

    async def _take_sample(self) -> None:
        result = self.snapshot()
        if asyncio.iscoroutine(result):
            sample = await result
        else:
            sample = result  # type: ignore[assignment]
        self._samples.append(sample)

    def query(self, window_seconds: float | None = None) -> list[MetricSample]:
        if window_seconds is None:
            return list(self._samples)
        if window_seconds <= 0:
            return []
        cutoff = time.monotonic() - window_seconds
        # Samples are appended in monotonic-time order, so `.monotonic`
        # is sorted. Use bisect on a materialised view to skip the prefix
        # that falls outside the window \u2014 cheaper than a list-comp
        # filter that scans every sample (hot polled path: timeseries
        # is fetched every 5s and often only needs the last ~60 of 720).
        samples = list(self._samples)
        if not samples:
            return []
        # Build a parallel list of `.monotonic` keys for bisect; this is
        # O(N) but a single tight loop in C, and bisect avoids the
        # Python-level conditional in the comprehension.
        keys = [s.monotonic for s in samples]
        idx = bisect.bisect_left(keys, cutoff)
        return samples[idx:]

    def latest(self) -> MetricSample | None:
        return self._samples[-1] if self._samples else None


def build_metric_sample(
    *,
    backlog: int,
    throughput_per_second: float,
    counters: dict[str, int],
    active_batches: int,
) -> MetricSample:
    """Helper used by the API layer to assemble a sample from live state."""
    ready = int(counters.get("ready", 0))
    running = int(counters.get("busy", 0))
    provisioning = int(counters.get("provisioning", 0))
    draining = int(counters.get("draining", 0)) + int(counters.get("terminating", 0))
    return MetricSample(
        timestamp=utc_now_iso(),
        monotonic=time.monotonic(),
        backlog=int(backlog),
        throughput_per_second=float(throughput_per_second),
        active_vms=ready + running + provisioning + draining,
        ready_vms=ready,
        running_vms=running,
        provisioning_vms=provisioning,
        draining_vms=draining,
        active_batches=int(active_batches),
    )
