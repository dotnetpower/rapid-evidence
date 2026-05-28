from __future__ import annotations

from fastapi.testclient import TestClient


def _spin_app(monkeypatch, *, event_buffer: int = 200, autostart: bool = True):
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MIN_READY", "1")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MAX_NODES", "3")
    monkeypatch.setenv("RAPID_EVIDENCE_HEARTBEAT_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_RECONCILE_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_METRICS_INTERVAL_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_EVENT_BUFFER", str(event_buffer))
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_AUTOSTART", "true" if autostart else "false")
    # Re-import the app so the lifespan sees the updated env.
    import importlib

    import rapid_evidence.api as api_module

    importlib.reload(api_module)
    return api_module.app


def test_events_endpoint_returns_recent_events_in_envelope(monkeypatch):
    app = _spin_app(monkeypatch)
    with TestClient(app) as client:
        # Force at least one heartbeat so we get a record we can read back.
        client.post("/pool/heartbeat")
        resp = client.get("/events?limit=50")
        assert resp.status_code == 200
        body = resp.json()
        assert "events" in body
        assert isinstance(body["events"], list)
        assert body["events"], "expected at least one recorded event"
        first = body["events"][0]
        assert {"event_type", "timestamp", "payload"} <= set(first.keys())


def test_events_since_filter_returns_only_newer(monkeypatch):
    app = _spin_app(monkeypatch)
    with TestClient(app) as client:
        client.post("/pool/heartbeat")
        first = client.get("/events?limit=200").json()["events"]
        assert first, "expected at least one event"
        anchor = first[-1]["timestamp"]
        client.post("/pool/heartbeat")
        newer = client.get(f"/events?since={anchor}").json()["events"]
        for event in newer:
            assert event["timestamp"] > anchor


def test_events_limit_is_clamped(monkeypatch):
    app = _spin_app(monkeypatch, event_buffer=8)
    with TestClient(app) as client:
        for _ in range(12):
            client.post("/pool/heartbeat")
        body = client.get("/events?limit=5").json()
        assert len(body["events"]) <= 5


def test_events_returns_empty_when_pool_disabled(monkeypatch):
    app = _spin_app(monkeypatch, autostart=False)
    with TestClient(app) as client:
        body = client.get("/events").json()
        assert body == {"events": []}


def test_scaling_timeline_returns_samples_and_filtered_events(monkeypatch):
    app = _spin_app(monkeypatch)
    with TestClient(app) as client:
        client.post("/pool/heartbeat")
        body = client.get("/scaling/timeline?window_seconds=600").json()
        assert body["window_seconds"] == 600.0
        assert isinstance(body["samples"], list)
        assert isinstance(body["events"], list)
        scaling_types = {
            "node_provisioned",
            "node_evicted",
            "scale_up",
            "scale_down",
            "node_replaced",
        }
        for event in body["events"]:
            assert event["event_type"] in scaling_types


def test_event_buffer_env_propagates_to_manager(monkeypatch):
    app = _spin_app(monkeypatch, event_buffer=3)
    with TestClient(app) as client:
        for _ in range(10):
            client.post("/pool/heartbeat")
        body = client.get("/events?limit=200").json()
        # Manager keeps at most event_buffer events; /events returns all of them.
        assert len(body["events"]) <= 3
