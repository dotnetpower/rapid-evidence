"""API integration tests for /batches, /metrics, /dashboard/summary."""

import time

import pytest
from fastapi.testclient import TestClient

import rapid_evidence.api as api


class FakeSource:
    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.calls: list[str] = []

    def fetch(self, url: str, headers=None):
        self.calls.append(url)
        if self.delay:
            time.sleep(self.delay)
        return {"ok": True, "body": b"x", "status": 200, "attempts": 1}


class InMemorySink:
    def __init__(self):
        self.writes: list = []

    def write(self, result):
        self.writes.append(result)


@pytest.fixture
def client(monkeypatch):
    """A TestClient with the batch executor wired to a fake source & in-memory sink."""
    fake_source = FakeSource(delay=0.005)
    sink = InMemorySink()
    monkeypatch.setattr(api, "default_source_client_factory", lambda src: fake_source)
    monkeypatch.setattr(api, "default_result_sink", lambda: sink)
    monkeypatch.setenv("RAPID_EVIDENCE_REMOTE_DISPATCH", "false")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MIN_READY", "1")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MAX_NODES", "4")
    monkeypatch.setenv("RAPID_EVIDENCE_HEARTBEAT_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_RECONCILE_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_METRICS_INTERVAL_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_METRICS_RETENTION_SECONDS", "5")
    with TestClient(api.app) as ctx:
        yield ctx, fake_source, sink


def _wait_for(ctx_client: TestClient, batch_id: str, predicate, *, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        resp = ctx_client.get(f"/batches/{batch_id}")
        assert resp.status_code == 200
        last = resp.json()
        if predicate(last):
            return last
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting; last={last}")


def test_create_batch_returns_progress_payload_with_expected_fields(client):
    ctx, _, _ = client
    resp = ctx.post(
        "/batches",
        json={"source": "generic-http", "targets": [f"https://example.com/{i}" for i in range(3)]},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["source"] == "generic-http"
    assert body["total"] == 3
    assert body["status"] in {"queued", "running", "done"}
    assert "workers_target" in body
    assert body["batch_id"].startswith("batch-")


def test_batch_runs_to_completion_and_lists_with_progress(client):
    ctx, source, sink = client
    resp = ctx.post(
        "/batches",
        json={
            "source": "generic-http",
            "targets": [f"https://example.com/{i}" for i in range(4)],
            "workers": 4,
        },
    )
    batch_id = resp.json()["batch_id"]

    final = _wait_for(ctx, batch_id, lambda b: b["status"] == "done")
    assert final["completed"] == 4
    assert final["failed"] == 0
    assert final["percent"] == 100.0
    assert final["eta_seconds"] == 0.0
    assert len(sink.writes) == 4

    listed = ctx.get("/batches").json()["batches"]
    assert any(b["batch_id"] == batch_id for b in listed)


def test_cancel_batch_returns_cancelled_status(client):
    ctx, source, _ = client
    source.delay = 0.1  # slow down so we can cancel mid-flight
    resp = ctx.post(
        "/batches",
        json={
            "source": "generic-http",
            "targets": [f"https://example.com/{i}" for i in range(50)],
            "workers": 1,
        },
    )
    batch_id = resp.json()["batch_id"]
    time.sleep(0.05)
    cancel_resp = ctx.post(f"/batches/{batch_id}/cancel")
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"


def test_create_batch_rejects_empty_targets(client):
    ctx, _, _ = client
    resp = ctx.post("/batches", json={"source": "generic-http", "targets": []})
    assert resp.status_code == 422


def test_get_unknown_batch_returns_404(client):
    ctx, _, _ = client
    assert ctx.get("/batches/batch-nope").status_code == 404
    assert ctx.post("/batches/batch-nope/cancel").status_code == 404


def test_metrics_timeseries_returns_samples_with_expected_shape(client):
    ctx, _, _ = client
    # Give the collector a moment to take 2+ samples.
    time.sleep(0.15)
    resp = ctx.get("/metrics/timeseries", params={"window_seconds": 60})
    assert resp.status_code == 200
    body = resp.json()
    assert body["sample_interval_seconds"] == 0.05
    assert isinstance(body["samples"], list)
    assert len(body["samples"]) >= 1
    sample = body["samples"][0]
    for key in (
        "timestamp",
        "backlog",
        "throughput_per_second",
        "active_vms",
        "ready_vms",
        "running_vms",
        "provisioning_vms",
        "draining_vms",
        "active_batches",
    ):
        assert key in sample


def test_dashboard_summary_aggregates_pool_and_batches(client):
    ctx, _, _ = client
    ctx.post(
        "/batches",
        json={"source": "generic-http", "targets": ["https://example.com/x"], "workers": 1},
    )
    time.sleep(0.2)
    resp = ctx.get("/dashboard/summary")
    assert resp.status_code == 200
    body = resp.json()
    assert "backlog" in body
    assert "throughput_per_second" in body
    assert "drain_eta_seconds" in body
    assert "active_batches" in body
    assert body["pool"]["running"] is True
    assert body["pool"]["counters"]["ready"] >= 0
    # scale_target is only available when pool is running
    assert body["scale_target"] is not None
    assert "target_nodes" in body["scale_target"]


def test_batch_timeline_endpoint_returns_recorded_events(client):
    ctx, _, _ = client
    create = ctx.post(
        "/batches",
        json={
            "source": "generic-http",
            "targets": ["https://example.com/t1", "https://example.com/t2"],
            "workers": 2,
        },
    )
    batch_id = create.json()["batch_id"]
    _wait_for(ctx, batch_id, lambda b: b["status"] == "done")

    resp = ctx.get(f"/batches/{batch_id}/timeline")
    assert resp.status_code == 200
    body = resp.json()
    assert "events" in body
    types = [e["event_type"] for e in body["events"]]
    # The executor records at least queued + started + finished.
    assert {"queued", "started", "finished"}.issubset(set(types))
    for evt in body["events"]:
        assert isinstance(evt.get("timestamp"), str)
        assert isinstance(evt.get("event_type"), str)
        assert isinstance(evt.get("payload"), dict)


def test_batch_timeline_returns_404_for_unknown_batch(client):
    ctx, _, _ = client
    resp = ctx.get("/batches/batch-does-not-exist/timeline")
    assert resp.status_code == 404
