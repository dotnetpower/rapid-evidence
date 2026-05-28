"""Tests for the BackgroundJobRegistry."""

from __future__ import annotations

import asyncio

import pytest

from rapid_evidence.jobs import BackgroundJobRegistry, run_tracked


def test_start_finish_records_status_and_duration():
    reg = BackgroundJobRegistry()
    job = reg.start("scan", metadata={"foo": "bar"})
    assert job.status == "running"
    assert job.finished_at is None
    out = reg.finish(job.job_id, status="succeeded", result={"hits": 3})
    assert out is not None
    assert out.status == "succeeded"
    assert out.finished_at is not None
    assert out.duration_seconds is not None and out.duration_seconds >= 0
    assert out.result == {"hits": 3}
    assert out.metadata == {"foo": "bar"}


def test_finish_unknown_job_returns_none():
    reg = BackgroundJobRegistry()
    assert reg.finish("missing", status="succeeded") is None


def test_list_is_chronological_and_capped():
    reg = BackgroundJobRegistry(max_jobs=3)
    jobs = [reg.start(f"j{i}") for i in range(5)]
    listed = reg.list()
    # Only the last 3 survive.
    names = [j.name for j in listed]
    assert names == ["j2", "j3", "j4"]
    # Older jobs are unreachable.
    assert reg.get(jobs[0].job_id) is None
    assert reg.get(jobs[4].job_id) is not None


def test_run_tracked_succeeds_and_coerces_list_result():
    reg = BackgroundJobRegistry()

    async def scenario():
        async def work():
            return [1, 2, 3]

        job, value = await run_tracked(reg, "w", work)
        assert value == [1, 2, 3]
        assert job.status == "succeeded"
        assert job.result == {"items": [1, 2, 3], "count": 3}

    asyncio.run(scenario())


def test_run_tracked_captures_exception_as_failed_job():
    reg = BackgroundJobRegistry()

    async def scenario():
        async def boom():
            raise RuntimeError("nope")

        job, value = await run_tracked(reg, "boom", boom)
        assert value is None
        assert job.status == "failed"
        assert job.error == "nope"

    asyncio.run(scenario())


def test_run_tracked_propagates_cancellation():
    reg = BackgroundJobRegistry()

    async def scenario():
        async def hang():
            await asyncio.sleep(60)

        task = asyncio.create_task(run_tracked(reg, "hang", hang))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        listed = reg.list()
        assert listed[-1].status == "cancelled"

    asyncio.run(scenario())


def test_update_metadata_merges_keys():
    reg = BackgroundJobRegistry()
    job = reg.start("scan", metadata={"a": 1})
    reg.update_metadata(job.job_id, {"b": 2})
    fresh = reg.get(job.job_id)
    assert fresh is not None
    assert fresh.metadata == {"a": 1, "b": 2}
