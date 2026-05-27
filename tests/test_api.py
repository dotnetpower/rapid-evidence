from fastapi.testclient import TestClient

from rapid_evidence.api import app


client = TestClient(app)


def test_api_accepts_mixed_delimiters_and_returns_summary():
    payload = {
        "urls": "https://example.com/a, https://example.com/b\nhttps://example.com/a;\thttps://example.com/c",
        "min_vm": 1,
        "max_vm": 2,
    }

    response = client.post("/run", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["valid_count"] >= 3
    assert data["duplicate_count"] >= 1
    assert "results" in data
    assert data["pool"]["min_vm"] == 1
    assert data["pool"]["max_vm"] == 2


def test_lifespan_starts_pool_and_exposes_status(monkeypatch):
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MIN_READY", "2")
    monkeypatch.setenv("RAPID_EVIDENCE_SPOT_MAX_NODES", "4")
    monkeypatch.setenv("RAPID_EVIDENCE_HEARTBEAT_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_RECONCILE_SECONDS", "0.05")
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_AUTOSTART", "true")

    # New app with lifespan triggered by using TestClient as context manager.
    from rapid_evidence.api import app as fresh_app

    with TestClient(fresh_app) as ctx_client:
        status = ctx_client.get("/pool/status").json()
        assert status["running"] is True
        assert status["provider"] == "in-memory"
        assert status["counters"]["ready"] >= 2
        assert status["config"]["min_ready"] == 2

        scale = ctx_client.post("/pool/scale", json={"requested_tasks": 3}).json()
        assert scale["plan"]["target_nodes"] == 3
        assert scale["snapshot"]["counters"]["ready"] >= 3

        heartbeat = ctx_client.post("/pool/heartbeat").json()
        assert "snapshot" in heartbeat
        assert heartbeat["snapshot"]["metrics"]["heartbeat_count"] >= 1

        reconcile = ctx_client.post("/pool/reconcile").json()
        assert "result" in reconcile
        assert reconcile["snapshot"]["metrics"]["reconcile_count"] >= 1

    # After lifespan exit, the pool manager is cleared.
    assert getattr(fresh_app.state, "pool_manager", None) is None


def test_lifespan_disabled_when_autostart_false(monkeypatch):
    monkeypatch.setenv("RAPID_EVIDENCE_POOL_AUTOSTART", "false")

    from rapid_evidence.api import app as fresh_app

    with TestClient(fresh_app) as ctx_client:
        status = ctx_client.get("/pool/status").json()
        assert status["running"] is False
        assert "autostart" in status["reason"]

        scale = ctx_client.post("/pool/scale", json={"requested_tasks": 1})
        assert scale.status_code == 503

