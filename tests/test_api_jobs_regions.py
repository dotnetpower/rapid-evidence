"""End-to-end tests for the new jobs / multi-region endpoints."""

from __future__ import annotations

import json
import subprocess

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_BATCHES_ROOT", str(tmp_path))
    monkeypatch.setenv("RAPID_EVIDENCE_AUDIT_LOG", str(tmp_path / "audit.log"))
    monkeypatch.setenv("RAPID_EVIDENCE_REMOTE_DISPATCH", "false")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_AUTOSTART", "true")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MIN_READY", "1")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_MAX_NODES", "2")
    # Stop the auto-region scan from running during tests (we trigger it
    # manually via POST /quota/probe-regions instead).
    monkeypatch.setenv("RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS", "0")

    from rapid_evidence import api as api_module

    with TestClient(api_module.app) as c:
        yield c


def _completed(stdout: str = "", returncode: int = 0, stderr: str = ""):
    return subprocess.CompletedProcess(
        args=["az"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_jobs_endpoint_returns_empty_list_initially(client):
    resp = client.get("/jobs")
    assert resp.status_code == 200
    assert resp.json() == {"jobs": []}


def test_jobs_get_unknown_returns_404(client):
    assert client.get("/jobs/missing").status_code == 404


def test_quota_probe_regions_triggers_tracked_job(client, monkeypatch):
    from rapid_evidence.spot import regions as regions_mod

    monkeypatch.setattr(regions_mod.shutil, "which", lambda _n: "/usr/bin/az")
    monkeypatch.setattr(
        regions_mod.subprocess,
        "run",
        lambda *a, **kw: _completed(
            stdout=json.dumps({"currentValue": 5, "limit": 20})
        ),
    )

    resp = client.post(
        "/quota/probe-regions",
        json={
            "regions": ["eastus", "westus", "koreacentral"],
            "spot_quota_name": "standardDASv5Family",
            "requested_per_region": 1,
            "max_parallelism": 4,
            "per_region_timeout_seconds": 5,
        },
    )
    assert resp.status_code == 202
    job = resp.json()
    assert job["name"] == "azure-region-quota-scan"
    assert job["status"] == "succeeded"
    assert job["result"]["totals"]["regions_observed"] == 3
    assert job["result"]["totals"]["limit"] == 60
    assert job["result"]["totals"]["used"] == 15
    assert sorted(job["result"]["sufficient_regions"]) == [
        "eastus",
        "koreacentral",
        "westus",
    ]
    # The job appears in the listing.
    listing = client.get("/jobs").json()
    assert any(j["job_id"] == job["job_id"] for j in listing["jobs"])


def test_quota_request_increase_returns_manual_plan_and_records_job(client):
    resp = client.post(
        "/quota/request-increase",
        json={"region": "eastus", "new_limit": 64},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "manual_action_required"
    assert body["region"] == "eastus"
    assert "job_id" in body
    job_resp = client.get(f"/jobs/{body['job_id']}")
    assert job_resp.status_code == 200
    assert job_resp.json()["status"] == "succeeded"
