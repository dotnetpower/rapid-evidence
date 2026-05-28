"""BatchRegistry + executor: progress tracking, throughput, cancellation."""

import asyncio
import time

import pytest

from rapid_evidence.batches import BatchExecutor, BatchRegistry, BatchStatus


class FakeSource:
    def __init__(self, delay: float = 0.0, fail_targets: set[str] | None = None):
        self.delay = delay
        self.fail_targets = fail_targets or set()
        self.calls: list[str] = []

    def fetch(self, url: str, headers: dict[str, str] | None = None) -> dict:
        self.calls.append(url)
        if self.delay:
            time.sleep(self.delay)
        if url in self.fail_targets:
            raise RuntimeError(f"forced failure for {url}")
        return {"ok": True, "body": b"hello", "status": 200, "attempts": 1}


class InMemorySink:
    def __init__(self):
        self.writes: list = []

    def write(self, result) -> None:
        self.writes.append(result)


def _make_registry(source: FakeSource, sink: InMemorySink, *, default_workers: int = 2):
    return BatchRegistry(
        executor_factory=lambda src: BatchExecutor(source_client=source, sink=sink),
        default_workers=default_workers,
    )


@pytest.mark.asyncio
async def test_submit_and_run_to_completion_records_throughput_and_eta():
    source = FakeSource()
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=4)

    record = await registry.submit(
        source="generic-http",
        targets=[f"https://example.com/{i}" for i in range(8)],
    )
    # wait until executor finishes
    await record._task
    progress = registry.progress(record.batch_id)

    assert progress is not None
    assert progress.status == BatchStatus.DONE
    assert progress.total == 8
    assert progress.completed == 8
    assert progress.failed == 0
    assert progress.percent == 100.0
    assert progress.eta_seconds == 0.0
    assert len(sink.writes) == 8
    assert source.calls == sorted(source.calls)  # all called


@pytest.mark.asyncio
async def test_failed_fetch_recorded_as_failure_not_completion():
    source = FakeSource(fail_targets={"https://example.com/bad"})
    sink = InMemorySink()
    registry = _make_registry(source, sink)

    record = await registry.submit(
        source="generic-http",
        targets=["https://example.com/ok", "https://example.com/bad"],
    )
    await record._task
    progress = registry.progress(record.batch_id)

    assert progress.completed == 1
    assert progress.failed == 1
    assert progress.status == BatchStatus.DONE  # mixed success/failure still terminates


@pytest.mark.asyncio
async def test_cancel_marks_batch_cancelled_without_finishing_remaining():
    source = FakeSource(delay=0.05)
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=1)

    record = await registry.submit(
        source="generic-http",
        targets=[f"https://example.com/{i}" for i in range(20)],
    )
    # let one or two finish
    await asyncio.sleep(0.08)
    progress = await registry.cancel(record.batch_id)

    assert progress.status == BatchStatus.CANCELLED
    assert progress.completed < 20
    # cancel returns once the task is fully unwound
    assert record._task.done()


@pytest.mark.asyncio
async def test_registry_backlog_throughput_and_drain_eta_are_aggregated():
    source = FakeSource()
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=8)

    r1 = await registry.submit(
        source="generic-http", targets=[f"https://example.com/a/{i}" for i in range(5)]
    )
    r2 = await registry.submit(
        source="generic-http", targets=[f"https://example.com/b/{i}" for i in range(5)]
    )
    await asyncio.gather(r1._task, r2._task)

    # All done — backlog is zero, drain ETA is zero, throughput is non-negative.
    assert registry.backlog() == 0
    assert registry.drain_eta_seconds() == 0.0
    assert registry.aggregate_throughput_per_second() >= 0.0
    assert registry.active_batch_count() == 0


@pytest.mark.asyncio
async def test_drain_eta_none_when_no_throughput_and_backlog_pending():
    # Submit a batch where the source blocks until we cancel — so backlog > 0
    # but no completion has been recorded yet -> ETA should be None.
    source = FakeSource(delay=10.0)
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=1)

    record = await registry.submit(
        source="generic-http",
        targets=[f"https://example.com/{i}" for i in range(3)],
    )
    # give the loop a tick but no completions yet
    await asyncio.sleep(0.01)
    assert registry.backlog() >= 1
    assert registry.drain_eta_seconds() is None

    await registry.cancel(record.batch_id)


@pytest.mark.asyncio
async def test_submit_rejects_empty_targets():
    registry = _make_registry(FakeSource(), InMemorySink())
    with pytest.raises(ValueError):
        await registry.submit(source="generic-http", targets=[])
    with pytest.raises(ValueError):
        await registry.submit(source="generic-http", targets=["   "])


@pytest.mark.asyncio
async def test_notify_eviction_updates_batch_evictions_observed():
    """Eviction events routed via notify_eviction bump the affected batch's counter
    and are reflected in BatchProgress.metadata['evictions_observed'].
    """
    source = FakeSource(delay=0.05)
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=1)

    record = await registry.submit(
        source="generic-http",
        targets=[f"https://example.com/{i}" for i in range(3)],
    )
    request_ids = [req.request_id for req in record.requests]

    affected = registry.notify_eviction(
        requeue_task_ids=(request_ids[0], request_ids[2]),
        reason="evicted",
    )
    assert affected == {record.batch_id: 2}
    assert record.evictions_observed == 2

    progress = registry.progress(record.batch_id)
    assert progress is not None
    assert progress.metadata.get("evictions_observed") == 2

    # Unknown request IDs are silently ignored (no exception, no entry).
    affected_again = registry.notify_eviction(
        requeue_task_ids=("req-unknown-xyz",), reason="failed"
    )
    assert affected_again == {}

    await record._task


@pytest.mark.asyncio
async def test_history_records_lifecycle_events_and_caps_at_256():
    """BatchRecord.history captures queued/started/finished plus eviction events,
    and is FIFO-capped at 256 entries so it cannot grow unbounded.
    """
    source = FakeSource()
    sink = InMemorySink()
    registry = _make_registry(source, sink, default_workers=2)

    record = await registry.submit(
        source="generic-http",
        targets=[f"https://example.com/{i}" for i in range(3)],
    )
    await record._task

    event_types = [e["event_type"] for e in record.history]
    assert "queued" in event_types
    assert "started" in event_types
    assert "finished" in event_types
    # Each event carries a timestamp and a dict payload.
    for entry in record.history:
        assert isinstance(entry["timestamp"], str) and entry["timestamp"]
        assert isinstance(entry["payload"], dict)

    # Eviction events flow through notify_eviction.
    registry.notify_eviction(
        requeue_task_ids=(record.requests[0].request_id,), reason="evicted"
    )
    evicted = [e for e in record.history if e["event_type"] == "evicted"]
    assert len(evicted) == 1
    assert evicted[0]["payload"]["reason"] == "evicted"
    assert record.requests[0].request_id in evicted[0]["payload"]["request_ids"]

    progress = registry.progress(record.batch_id)
    assert progress is not None
    assert progress.metadata.get("evicted_request_ids") == [
        record.requests[0].request_id
    ]

    # FIFO cap at 256 — pump synthetic events past the limit and verify only the
    # newest 256 survive while preserving order.
    for i in range(400):
        record.record_event("synthetic", {"i": i})
    assert len(record.history) == 256
    last = record.history[-1]
    assert last["event_type"] == "synthetic"
    assert last["payload"]["i"] == 399
    # The oldest synthetic still present is 399 - 255 = 144 (since the cap keeps
    # the most recent 256 entries).
    first_synthetic = next(e for e in record.history if e["event_type"] == "synthetic")
    assert first_synthetic["payload"]["i"] == 400 - 256

