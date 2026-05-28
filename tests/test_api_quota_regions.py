"""API tests for /quota/status and /regions/status with a live in-process app."""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_BATCHES_ROOT", str(tmp_path))
    monkeypatch.setenv("RAPID_EVIDENCE_AUDIT_LOG", str(tmp_path / "audit.log"))
    monkeypatch.setenv("RAPID_EVIDENCE_REMOTE_DISPATCH", "false")
    monkeypatch.setenv("RAPID_EVIDENCE_AUTOSTART_POOL", "true")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MIN_READY", "1")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MAX_NODES", "2")
    # Fast quota refresh so the loop populates quickly.
    monkeypatch.setenv("RAPID_EVIDENCE_QUOTA_REFRESH_SECONDS", "0.05")
    # Disable the multi-region scan loop so it does not hit real `az`
    # during these tests.
    monkeypatch.setenv("RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS", "0")

    from rapid_evidence import api as api_module

    with TestClient(api_module.app) as c:
        yield c


def test_quota_status_returns_observed_after_refresh(client):
    # Force a refresh so we don't depend on the loop timing.
    pool_manager = client.app.state.pool_manager
    import asyncio

    asyncio.run(pool_manager.refresh_quota_once())
    resp = client.get("/quota/status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["observed"] is True
    assert "used" in data
    assert "limit" in data
    assert data["is_sufficient"] is True
    assert "checked_at" in data


def test_regions_status_groups_by_region(client):
    resp = client.get("/regions/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "regions" in data
    # In-memory provider does not stamp a region; expect one bucket with
    # region=None (or "(unknown)") containing all warmed nodes.
    assert len(data["regions"]) >= 1
    total_nodes = sum(r["nodes"] for r in data["regions"])
    assert total_nodes >= 1
    for r in data["regions"]:
        assert "nodes" in r
        assert "ready" in r
        assert "busy" in r
        assert "evictions_recent" in r


def test_quota_status_includes_error_when_provider_fails(monkeypatch, tmp_path):
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_BATCHES_ROOT", str(tmp_path))
    monkeypatch.setenv("RAPID_EVIDENCE_AUDIT_LOG", str(tmp_path / "audit.log"))
    monkeypatch.setenv("RAPID_EVIDENCE_REMOTE_DISPATCH", "false")
    monkeypatch.setenv("RAPID_EVIDENCE_AUTOSTART_POOL", "true")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MIN_READY", "1")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MAX_NODES", "2")
    monkeypatch.setenv("RAPID_EVIDENCE_QUOTA_REFRESH_SECONDS", "60")
    monkeypatch.setenv("RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS", "0")

    from rapid_evidence import api as api_module

    with TestClient(api_module.app) as c:
        pool_manager = c.app.state.pool_manager

        # Inject a failing check_quota at runtime to simulate Azure throttling.
        def boom(_requested, _config):
            raise RuntimeError("simulated cli failure")

        pool_manager.scheduler.provider.check_quota = boom  # type: ignore[attr-defined]

        import asyncio

        asyncio.run(pool_manager.refresh_quota_once())
        resp = c.get("/quota/status")
        assert resp.status_code == 200
        data = resp.json()
        # observed=True because checked_at is set, but quota fields will be absent.
        assert data["observed"] is True
        assert data.get("error") and "simulated cli failure" in data["error"]
