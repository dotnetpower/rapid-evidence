"""Worker dispatch transports.

A `WorkerTransport` knows how to send a `WorkerDispatchPayload` to a
specific `SpotNode` and return a `WorkerDispatchResult`. Two
implementations ship:

* `HttpWorkerTransport` — talks HTTPS-or-HTTP to the on-VM agent. Used
  in production with the `azure-cli` provider.
* `InMemoryWorkerTransport` — calls a Python handler with the payload.
  Used by tests and by the `in-memory` Spot provider so the developer
  loop and the dashboard demo work without touching the network.

Transports MUST raise `WorkerDispatchError` for any failure that should
trigger a retry on a different node (TCP errors, timeouts, 5xx, auth
failures). They MUST NOT raise for "fetch succeeded but origin returned
4xx" — that is reported through `WorkerDispatchResult.status_code` and
treated as a legitimate fetch outcome by the source layer.
"""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from rapid_evidence.spot.models import SpotNode


class WorkerDispatchError(Exception):
    """Transport-level failure (node unreachable, auth, malformed response).

    The remote worker source treats this as a retryable signal and will
    pick a different node on the next attempt.
    """


@dataclass(frozen=True)
class WorkerDispatchPayload:
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    method: str = "GET"
    max_body_bytes: int = 1_000_000
    timeout_seconds: float = 30.0
    max_attempts: int = 3
    request_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "headers": dict(self.headers),
            "method": self.method,
            "max_body_bytes": self.max_body_bytes,
            "timeout_seconds": self.timeout_seconds,
            "max_attempts": self.max_attempts,
            "request_id": self.request_id,
        }


@dataclass(frozen=True)
class WorkerDispatchResult:
    ok: bool
    status_code: int | None
    body: bytes
    attempts: int = 1
    outbound_ip: str | None = None
    node_id: str | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status_code,
            "body": base64.b64encode(self.body).decode("ascii"),
            "attempts": self.attempts,
            "outbound_ip": self.outbound_ip,
            "node_id": self.node_id,
            "error": self.error,
        }


class WorkerTransport(Protocol):
    async def dispatch(
        self, node: SpotNode, payload: WorkerDispatchPayload
    ) -> WorkerDispatchResult: ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------- #
# In-memory transport
# --------------------------------------------------------------------- #


# Handler signature: (node, payload) -> dict-like with keys body/status/error.
# Sync or async are both supported.
InMemoryHandler = Callable[
    [SpotNode, WorkerDispatchPayload],
    "WorkerDispatchResult | dict[str, Any] | Awaitable[WorkerDispatchResult | dict[str, Any]]",
]


def _default_in_memory_handler(
    node: SpotNode, payload: WorkerDispatchPayload
) -> WorkerDispatchResult:
    body = f"echo: {payload.url} (via {node.node_id})".encode("utf-8")
    return WorkerDispatchResult(
        ok=True,
        status_code=200,
        body=body[: payload.max_body_bytes],
        attempts=1,
        outbound_ip=node.outbound_ip,
        node_id=node.node_id,
    )


class InMemoryWorkerTransport:
    """In-process transport used by tests and the in-memory demo provider.

    `handler` is invoked with `(node, payload)` and must return either a
    `WorkerDispatchResult` or a dict the transport coerces into one.
    """

    def __init__(
        self,
        *,
        handler: InMemoryHandler | None = None,
        simulated_delay_seconds: float = 0.0,
    ) -> None:
        if simulated_delay_seconds < 0:
            raise ValueError("simulated_delay_seconds must be non-negative")
        self.handler = handler or _default_in_memory_handler
        self.simulated_delay_seconds = simulated_delay_seconds
        self.dispatches: list[tuple[str, WorkerDispatchPayload]] = []

    async def dispatch(
        self, node: SpotNode, payload: WorkerDispatchPayload
    ) -> WorkerDispatchResult:
        if self.simulated_delay_seconds > 0:
            await asyncio.sleep(self.simulated_delay_seconds)
        outcome = self.handler(node, payload)
        if asyncio.iscoroutine(outcome):
            outcome = await outcome
        self.dispatches.append((node.node_id, payload))
        if isinstance(outcome, WorkerDispatchResult):
            return outcome
        if isinstance(outcome, dict):
            body = outcome.get("body", b"")
            if isinstance(body, str):
                body = body.encode("utf-8")
            return WorkerDispatchResult(
                ok=bool(outcome.get("ok", True)),
                status_code=outcome.get("status"),
                body=body[: payload.max_body_bytes] if isinstance(body, bytes) else b"",
                attempts=int(outcome.get("attempts", 1)),
                outbound_ip=outcome.get("outbound_ip", node.outbound_ip),
                node_id=node.node_id,
                error=outcome.get("error"),
            )
        raise WorkerDispatchError(
            f"handler returned unsupported type: {type(outcome).__name__}"
        )

    async def aclose(self) -> None:
        return None


# --------------------------------------------------------------------- #
# HTTP transport (talks to the on-VM agent)
# --------------------------------------------------------------------- #


class HttpWorkerTransport:
    """Sends dispatch payloads to the on-VM HTTP agent.

    The on-VM agent listens on `agent_port` and authenticates the
    `Authorization: Bearer <shared_secret>` header. Bodies are returned
    as base64-encoded strings under `body`.
    """

    def __init__(
        self,
        *,
        shared_secret: str,
        agent_port: int = 8765,
        scheme: str = "http",
        connect_timeout_seconds: float = 5.0,
        request_timeout_seconds: float = 120.0,
    ) -> None:
        if not shared_secret:
            raise ValueError("shared_secret is required")
        if agent_port <= 0 or agent_port > 65535:
            raise ValueError("agent_port must be a valid TCP port")
        if scheme not in {"http", "https"}:
            raise ValueError("scheme must be http or https")
        self.shared_secret = shared_secret
        self.agent_port = agent_port
        self.scheme = scheme
        self.connect_timeout_seconds = connect_timeout_seconds
        self.request_timeout_seconds = request_timeout_seconds
        self._client = None

    async def _ensure_client(self):
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    self.request_timeout_seconds,
                    connect=self.connect_timeout_seconds,
                )
            )
        return self._client

    async def dispatch(
        self, node: SpotNode, payload: WorkerDispatchPayload
    ) -> WorkerDispatchResult:
        if not node.public_ip:
            raise WorkerDispatchError(f"node {node.node_id} has no public_ip")
        url = f"{self.scheme}://{node.public_ip}:{self.agent_port}/fetch"
        client = await self._ensure_client()
        try:
            response = await client.post(
                url,
                json=payload.to_json(),
                headers={"Authorization": f"Bearer {self.shared_secret}"},
            )
        except Exception as exc:  # noqa: BLE001 — translate any httpx error
            raise WorkerDispatchError(
                f"dispatch to {node.node_id} ({node.public_ip}) failed: {exc}"
            ) from exc
        if response.status_code == 401:
            raise WorkerDispatchError(
                f"agent on {node.node_id} rejected auth (401)"
            )
        if response.status_code >= 500:
            raise WorkerDispatchError(
                f"agent on {node.node_id} returned {response.status_code}: "
                f"{response.text[:200]}"
            )
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise WorkerDispatchError(
                f"agent on {node.node_id} returned non-JSON: {exc}"
            ) from exc
        body_b64 = data.get("body", "")
        try:
            body = base64.b64decode(body_b64) if body_b64 else b""
        except (ValueError, TypeError) as exc:
            raise WorkerDispatchError(
                f"agent on {node.node_id} returned non-base64 body: {exc}"
            ) from exc
        return WorkerDispatchResult(
            ok=bool(data.get("ok", response.status_code < 400)),
            status_code=data.get("status"),
            body=body[: payload.max_body_bytes],
            attempts=int(data.get("attempts", 1)),
            outbound_ip=data.get("outbound_ip"),
            node_id=node.node_id,
            error=data.get("error"),
        )

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
