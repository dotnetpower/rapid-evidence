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
