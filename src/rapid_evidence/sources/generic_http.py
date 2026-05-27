import email.utils
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx

from rapid_evidence.core.errors import SourceFetchError
from rapid_evidence.core.models import FetchRequest
from rapid_evidence.sources.url_guard import GuardedHTTPTransport, validate_public_http_url


@dataclass
class GenericHttpSource:
    max_body_bytes: int = 1_000_000
    timeout_seconds: float = 30.0
    max_attempts: int = 3

    def __post_init__(self):
        if self.max_body_bytes <= 0:
            raise ValueError("max_body_bytes must be positive")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if self.max_attempts <= 0:
            raise ValueError("max_attempts must be positive")

    def fetch(self, url: str, headers: dict[str, str] | None = None) -> dict:
        validate_public_http_url(url)
        headers = headers or {}
        body = bytearray()
        attempt = 0
        while attempt < self.max_attempts:
            attempt += 1
            client = httpx.Client(transport=GuardedHTTPTransport(), follow_redirects=False, timeout=self.timeout_seconds)
            try:
                response = client.stream("GET", url, headers=headers)
                try:
                    response.raise_for_status()
                    for chunk in response.iter_bytes(8192):
                        if len(body) + len(chunk) > self.max_body_bytes:
                            body.extend(chunk[: max(self.max_body_bytes - len(body), 0)])
                            break
                        body.extend(chunk)
                    redirect = response.headers.get("location")
                    if redirect:
                        redirect_url = str(redirect)
                        validate_public_http_url(redirect_url)
                        url = redirect_url
                        continue
                    return {"ok": True, "body": bytes(body), "status": response.status_code, "attempts": attempt}
                finally:
                    if hasattr(response, "close"):
                        response.close()
            except httpx.HTTPError as exc:
                if attempt >= self.max_attempts:
                    raise SourceFetchError(f"fetch failed: {exc}") from exc
                continue
            finally:
                if hasattr(client, "close"):
                    client.close()
        raise SourceFetchError("fetch failed")

    def _parse_retry_after(self, value: str | None) -> int:
        if not value:
            return 0
        try:
            seconds = int(value)
            return max(0, min(seconds, 300))
        except ValueError:
            pass
        try:
            dt = email.utils.parsedate_to_datetime(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = dt.astimezone(timezone.utc) - datetime.now(timezone.utc)
            return max(0, min(int(delta.total_seconds()), 300))
        except (TypeError, ValueError):
            return 0
