"""On-VM fetch agent — embedded daemon source code.

The constant `AGENT_SCRIPT` holds the full Python source that the host
embeds into cloud-init `write_files: content:` and that runs on each
Spot VM as a systemd service. Keeping it in its own module isolates
the (~220 LOC) string literal from the host-side install logic so the
SRP/300-line ceiling stays honest.

The script is deliberately stdlib-only — the VM image only needs
`python3` (already on Ubuntu 22.04).

Shape of the request body the agent receives::

    {
      "url": "...",
      "headers": {"Header": "Value"},
      "method": "GET",
      "max_body_bytes": 1000000,
      "timeout_seconds": 30.0,
      "max_attempts": 3,
      "request_id": "..."
    }

Shape of the response body::

    {
      "ok": true,
      "status": 200,
      "body": "<base64>",
      "attempts": 1,
      "outbound_ip": "1.2.3.4",
      "error": null
    }

The agent listens on `0.0.0.0:8765` and requires
``Authorization: Bearer <shared_secret>``. The secret is provisioned
through ``/etc/rapid-evidence/agent.env``.
"""

from __future__ import annotations

__all__ = ["AGENT_SCRIPT"]


AGENT_SCRIPT: str = r'''#!/usr/bin/env python3
"""Rapid Evidence on-VM fetch agent (stdlib only)."""
from __future__ import annotations

import base64
import http.server
import json
import logging
import os
import socketserver
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus

LOG = logging.getLogger("rapid-evidence-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

PORT = int(os.environ.get("RAPID_EVIDENCE_AGENT_PORT", "8765"))
SECRET = os.environ.get("RAPID_EVIDENCE_AGENT_SECRET", "").strip()
PROBE_URLS = [
    u.strip() for u in os.environ.get(
        "RAPID_EVIDENCE_AGENT_PROBE_URLS",
        "https://api.ipify.org,https://ifconfig.me/ip,https://icanhazip.com",
    ).split(",") if u.strip()
]
MAX_BODY_BYTES_CAP = int(os.environ.get("RAPID_EVIDENCE_AGENT_MAX_BODY_BYTES", "5000000"))
REQUEST_TIMEOUT_CAP = float(os.environ.get("RAPID_EVIDENCE_AGENT_TIMEOUT_CAP", "60"))


def discover_outbound_ip() -> str | None:
    for url in PROBE_URLS:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "rapid-evidence-agent/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.read().decode("utf-8", "replace").strip()
        except Exception as exc:  # noqa: BLE001
            LOG.warning("outbound probe %s failed: %s", url, exc)
    return None


OUTBOUND_IP: str | None = None


def perform_fetch(payload: dict) -> dict:
    url = payload.get("url")
    if not url or not isinstance(url, str):
        raise ValueError("url is required")
    if not url.startswith("https://"):
        raise ValueError("only https:// urls are accepted")
    headers = payload.get("headers") or {}
    if not isinstance(headers, dict):
        raise ValueError("headers must be an object")
    method = (payload.get("method") or "GET").upper()
    if method not in {"GET", "HEAD"}:
        raise ValueError("only GET/HEAD are accepted")
    timeout = float(payload.get("timeout_seconds") or 30.0)
    timeout = max(1.0, min(timeout, REQUEST_TIMEOUT_CAP))
    max_body = int(payload.get("max_body_bytes") or 1_000_000)
    max_body = max(1, min(max_body, MAX_BODY_BYTES_CAP))
    max_attempts = max(1, int(payload.get("max_attempts") or 1))

    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        req = urllib.request.Request(url, method=method)
        for key, value in headers.items():
            if isinstance(value, str):
                req.add_header(key, value)
        try:
            ctx = ssl.create_default_context()
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                status = getattr(resp, "status", None) or resp.getcode()
                body = bytearray()
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    body.extend(chunk)
                    if len(body) >= max_body:
                        body = body[:max_body]
                        break
                return {
                    "ok": True,
                    "status": int(status) if status else None,
                    "body": base64.b64encode(bytes(body)).decode("ascii"),
                    "attempts": attempt,
                }
        except urllib.error.HTTPError as exc:
            # 4xx is a legitimate fetch outcome — return immediately.
            body = b""
            try:
                body = exc.read()[:max_body]
            except Exception:  # noqa: BLE001
                pass
            return {
                "ok": False,
                "status": exc.code,
                "body": base64.b64encode(bytes(body)).decode("ascii"),
                "attempts": attempt,
                "error": f"HTTP {exc.code}",
            }
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < max_attempts:
                time.sleep(0.25 * attempt)
            continue
    return {
        "ok": False,
        "status": None,
        "body": "",
        "attempts": max_attempts,
        "error": f"fetch failed: {last_error}",
    }


class AgentHandler(http.server.BaseHTTPRequestHandler):
    server_version = "rapid-evidence-agent/1.0"

    def log_message(self, format, *args):  # noqa: A003 — stdlib API
        LOG.info("%s - %s", self.client_address[0], format % args)

    def _send_json(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _check_auth(self) -> bool:
        if not SECRET:
            return False
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {SECRET}"

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "outbound_ip": OUTBOUND_IP, "port": PORT},
            )
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/fetch":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        if not self._check_auth():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 1_000_000:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "bad content-length"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": f"bad json: {exc}"})
            return
        try:
            result = perform_fetch(payload)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": f"agent failure: {exc}"},
            )
            return
        result.setdefault("outbound_ip", OUTBOUND_IP)
        self._send_json(HTTPStatus.OK, result)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    global OUTBOUND_IP
    if not SECRET:
        LOG.error("RAPID_EVIDENCE_AGENT_SECRET is not set; refusing to start")
        return 2
    OUTBOUND_IP = discover_outbound_ip()
    LOG.info("rapid-evidence-agent starting on :%d (outbound_ip=%s)", PORT, OUTBOUND_IP)

    def refresh_outbound_ip():
        global OUTBOUND_IP
        while True:
            try:
                new_ip = discover_outbound_ip()
                if new_ip:
                    OUTBOUND_IP = new_ip
            except Exception as exc:  # noqa: BLE001
                LOG.warning("outbound refresh failed: %s", exc)
            time.sleep(120)

    t = threading.Thread(target=refresh_outbound_ip, name="outbound-refresh", daemon=True)
    t.start()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), AgentHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''
