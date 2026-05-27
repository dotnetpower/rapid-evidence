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
