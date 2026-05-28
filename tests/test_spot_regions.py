"""Tests for the multi-region quota probe."""

from __future__ import annotations

import asyncio
import json
import subprocess
from types import SimpleNamespace

import pytest

from rapid_evidence.spot import regions as regions_mod


def _completed(stdout: str = "", stderr: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(
        args=["az"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_probe_regions_returns_empty_report_for_empty_list():
    async def scenario():
        report = await regions_mod.probe_regions(regions=[])
        assert report.regions == []
        assert report.total_limit == 0

    asyncio.run(scenario())


def test_probe_regions_handles_missing_az_binary(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: None)

    async def scenario():
        report = await regions_mod.probe_regions(
            regions=("eastus", "westus"), az_binary="az-missing"
        )
        assert len(report.regions) == 2
        for p in report.regions:
            assert p.observed is False
            assert "not found on PATH" in (p.error or "")
        assert set(report.failed_regions) == {"eastus", "westus"}

    asyncio.run(scenario())


def test_probe_regions_parses_az_output_in_parallel(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: "/usr/bin/az")
    calls: list[tuple[str, ...]] = []

    def fake_run(cmd, capture_output, text, check, timeout=None):
        # extract the --location value
        loc = cmd[cmd.index("--location") + 1]
        calls.append(tuple(cmd))
        return _completed(stdout=json.dumps({"currentValue": 3, "limit": 10}))

    monkeypatch.setattr(regions_mod.subprocess, "run", fake_run)

    async def scenario():
        report = await regions_mod.probe_regions(
            regions=("eastus", "westus", "koreacentral"),
            spot_quota_name="standardDASv5Family",
            requested_per_region=1,
        )
        assert len(report.regions) == 3
        for p in report.regions:
            assert p.observed is True
            assert p.used == 3
            assert p.limit == 10
            assert p.headroom == 7
            assert p.is_sufficient is True
        assert report.total_limit == 30
        assert report.total_used == 9
        assert report.total_headroom == 21
        assert sorted(report.sufficient_regions) == ["eastus", "koreacentral", "westus"]
        assert report.failed_regions == []

    asyncio.run(scenario())
    assert len(calls) == 3


def test_probe_regions_treats_empty_output_as_quota_not_reported(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: "/usr/bin/az")
    monkeypatch.setattr(
        regions_mod.subprocess, "run", lambda *a, **kw: _completed(stdout="")
    )

    async def scenario():
        report = await regions_mod.probe_regions(regions=("eastus",))
        p = report.regions[0]
        assert p.observed is False
        assert p.error and "not reported" in p.error

    asyncio.run(scenario())


def test_probe_regions_marks_insufficient_when_headroom_below_request(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: "/usr/bin/az")
    monkeypatch.setattr(
        regions_mod.subprocess,
        "run",
        lambda *a, **kw: _completed(
            stdout=json.dumps({"currentValue": 9, "limit": 10})
        ),
    )

    async def scenario():
        report = await regions_mod.probe_regions(
            regions=("eastus",), requested_per_region=4
        )
        p = report.regions[0]
        assert p.is_sufficient is False
        assert report.insufficient_regions == ["eastus"]

    asyncio.run(scenario())


def test_probe_regions_returns_error_on_az_failure(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: "/usr/bin/az")
    monkeypatch.setattr(
        regions_mod.subprocess,
        "run",
        lambda *a, **kw: _completed(
            stdout="", stderr="ERROR: not authorised", returncode=1
        ),
    )

    async def scenario():
        report = await regions_mod.probe_regions(regions=("eastus",))
        p = report.regions[0]
        assert p.observed is False
        assert "not authorised" in (p.error or "")
        assert report.failed_regions == ["eastus"]

    asyncio.run(scenario())


def test_probe_regions_times_out_per_region(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _name: "/usr/bin/az")

    async def slow(*_a, **_kw):
        await asyncio.sleep(10)
        return _completed()

    # Replace asyncio.to_thread to await the slow coroutine directly.
    async def fake_to_thread(func, *args, **kwargs):
        return await slow()

    monkeypatch.setattr(regions_mod.asyncio, "to_thread", fake_to_thread)

    async def scenario():
        report = await regions_mod.probe_regions(
            regions=("eastus",), per_region_timeout_seconds=0.05
        )
        p = report.regions[0]
        assert p.observed is False
        assert "timed out" in (p.error or "")

    asyncio.run(scenario())


def test_request_quota_increase_returns_structured_manual_steps():
    plan = regions_mod.request_quota_increase(
        "eastus", spot_quota_name="standardDASv5Family", new_limit=64
    )
    assert plan["status"] == "manual_action_required"
    assert plan["region"] == "eastus"
    assert plan["new_limit"] == 64
    assert any("support tickets create" in step for step in plan["next_steps"])
    assert any("portal.azure.com" in step for step in plan["next_steps"])


def test_probe_regions_rejects_invalid_region_name():
    async def scenario():
        with pytest.raises(ValueError, match="invalid Azure region"):
            await regions_mod.probe_regions(regions=["east us"])
        with pytest.raises(ValueError, match="invalid Azure region"):
            await regions_mod.probe_regions(regions=["eastus; rm -rf /"])
        with pytest.raises(ValueError, match="invalid spot_quota_name"):
            await regions_mod.probe_regions(
                regions=["eastus"], spot_quota_name="bad name!"
            )

    asyncio.run(scenario())


def test_request_quota_increase_rejects_invalid_input():
    with pytest.raises(ValueError, match="invalid Azure region"):
        regions_mod.request_quota_increase(
            "east us", spot_quota_name="standardDASv5Family", new_limit=1
        )
    with pytest.raises(ValueError, match="invalid spot_quota_name"):
        regions_mod.request_quota_increase(
            "eastus", spot_quota_name="bad name", new_limit=1
        )
    with pytest.raises(ValueError, match="new_limit must be positive"):
        regions_mod.request_quota_increase(
            "eastus", spot_quota_name="standardDASv5Family", new_limit=0
        )


def test_jobs_get_returns_snapshot_not_live_reference():
    from rapid_evidence.jobs import BackgroundJobRegistry

    reg = BackgroundJobRegistry()
    job = reg.start("scan", metadata={"a": 1})
    snap = reg.get(job.job_id)
    assert snap is not None
    # Mutating the snapshot must NOT change the registry's view.
    snap.metadata["a"] = 999
    fresh = reg.get(job.job_id)
    assert fresh is not None and fresh.metadata["a"] == 1


def test_probe_regions_catches_subprocess_timeout(monkeypatch):
    monkeypatch.setattr(regions_mod.shutil, "which", lambda _n: "/usr/bin/az")

    def fake_run(cmd, capture_output, text, check, timeout=None):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout or 1.0)

    monkeypatch.setattr(regions_mod.subprocess, "run", fake_run)

    async def scenario():
        report = await regions_mod.probe_regions(
            regions=("eastus",), per_region_timeout_seconds=1.0
        )
        p = report.regions[0]
        assert p.observed is False
        assert "subprocess timed out" in (p.error or "")

    asyncio.run(scenario())
