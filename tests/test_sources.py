import httpx

from rapid_evidence.sources.generic_http import GenericHttpSource
from rapid_evidence.sources.url_guard import validate_public_http_url


def test_validate_public_http_url_rejects_private_ip():
    try:
        validate_public_http_url("http://127.0.0.1")
        assert False, "private IP should be rejected"
    except ValueError:
        pass


def test_generic_http_fetch_uses_truncated_stream(monkeypatch):
    class FakeResponse:
        def __init__(self):
            self.status_code = 200
            self.headers = {}
            self._chunks = [b"hello", b"world"]

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def iter_bytes(self, chunk_size):
            for chunk in self._chunks:
                yield chunk

        def raise_for_status(self):
            pass

        def close(self):
            pass

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.calls = []

        def stream(self, method, url, headers=None, timeout=None):
            self.calls.append((method, url, headers, timeout))
            return FakeResponse()

    source = GenericHttpSource(max_body_bytes=5)
    # monkeypatch the client factory used by source fetch by replacing httpx.Client
    monkeypatch.setattr("rapid_evidence.sources.generic_http.httpx.Client", FakeClient)

    result = source.fetch("https://example.com")

    assert result["ok"] is True
    assert len(result["body"]) <= 5
