"""Remote worker source — dispatches fetches to Spot VM agents.

Implements the same `fetch(url, headers) -> dict` shape as
`GenericHttpSource` but exposes it through `async def fetch_async` (and
a sync `fetch` for backwards compatibility with the existing source
client Protocol). The async path is preferred — the BatchExecutor
detects it automatically.

Lifecycle per call:

1.  Reserve one node via `SpotPoolManager.reserve(1)`. If no node is
    READY, poll for `reservation_wait_seconds` while the pool warms up.
2.  Dispatch the payload to that node via the configured transport.
3.  On `WorkerDispatchError`, mark the node FAILED so the reconcile loop
    replaces it, release the reservation, and retry on a different node
    up to `max_attempts` times.
4.  On success, release the reservation and return the body / status
    in the GenericHttpSource-compatible dict shape.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from rapid_evidence.core.errors import SourceFetchError
from rapid_evidence.spot.manager import SpotPoolManager
from rapid_evidence.spot.models import SpotNode
from rapid_evidence.worker.transport import (
    WorkerDispatchError,
    WorkerDispatchPayload,
    WorkerTransport,
)

logger = logging.getLogger(__name__)


class RemoteWorkerSource:
    """SourceClient that dispatches fetches to Spot VMs via a transport."""

    def __init__(
        self,
        *,
        pool_manager: SpotPoolManager,
        transport: WorkerTransport,
        max_attempts: int = 3,
        max_body_bytes: int = 1_000_000,
        request_timeout_seconds: float = 30.0,
        reservation_wait_seconds: float = 30.0,
        reservation_poll_interval_seconds: float = 0.25,
        scale_on_starvation: bool = True,
    ) -> None:
        if max_attempts <= 0:
            raise ValueError("max_attempts must be positive")
        if max_body_bytes <= 0:
            raise ValueError("max_body_bytes must be positive")
        if request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        if reservation_wait_seconds <= 0:
            raise ValueError("reservation_wait_seconds must be positive")
        if reservation_poll_interval_seconds <= 0:
            raise ValueError("reservation_poll_interval_seconds must be positive")
        self.pool_manager = pool_manager
        self.transport = transport
        self.max_attempts = max_attempts
        self.max_body_bytes = max_body_bytes
        self.request_timeout_seconds = request_timeout_seconds
        self.reservation_wait_seconds = reservation_wait_seconds
        self.reservation_poll_interval_seconds = reservation_poll_interval_seconds
        self.scale_on_starvation = scale_on_starvation

    # ----- public API used by BatchExecutor ----------------------------

    async def fetch_async(
        self,
        url: str,
        headers: dict[str, str] | None = None,
        *,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        payload = WorkerDispatchPayload(
            url=url,
            headers=dict(headers or {}),
            max_body_bytes=self.max_body_bytes,
            timeout_seconds=self.request_timeout_seconds,
            max_attempts=1,  # outer loop here owns retries
            request_id=request_id,
        )
        last_error: Exception | None = None
        tried_node_ids: set[str] = set()
        failed_node_ids: set[str] = set()
        for attempt in range(1, self.max_attempts + 1):
            node = await self._reserve_one(
                exclude=tried_node_ids, task_id=request_id
            )
            if node is None:
                last_error = SourceFetchError(
                    "no ready spot node available after reservation wait"
                )
                break
            tried_node_ids.add(node.node_id)
            try:
                result = await self.transport.dispatch(node, payload)
            except WorkerDispatchError as exc:
                last_error = exc
                logger.warning(
                    "dispatch to node %s failed (attempt %d/%d): %s",
                    node.node_id,
                    attempt,
                    self.max_attempts,
                    exc,
                )
                await self._mark_node_failed(node.node_id, str(exc))
                failed_node_ids.add(node.node_id)
                continue
            finally:
                # Release only if we did NOT mark this node failed —
                # otherwise scheduler.release would flip it back to READY.
                if node.node_id not in failed_node_ids:
                    try:
                        await self.pool_manager.release((node.node_id,))
                    except Exception as release_exc:  # noqa: BLE001
                        logger.warning(
                            "release of node %s raised: %s",
                            node.node_id,
                            release_exc,
                        )
            return {
                "ok": result.ok,
                "body": result.body,
                "status": result.status_code,
                "attempts": result.attempts,
                "outbound_ip": result.outbound_ip,
                "node_id": result.node_id,
                "error": result.error,
            }
        raise SourceFetchError(
            f"remote dispatch exhausted {self.max_attempts} attempts: {last_error}"
        ) from last_error

    def fetch(self, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
        """Sync shim around `fetch_async` for environments without a loop.

        Prefer `fetch_async` — the BatchExecutor detects it automatically
        and avoids creating an extra thread / event loop hop.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.fetch_async(url, headers))
        raise RuntimeError(
            "RemoteWorkerSource.fetch() called inside a running event loop; "
            "use fetch_async() instead"
        )

    # ----- helpers ------------------------------------------------------

    async def _reserve_one(
        self, *, exclude: set[str], task_id: str | None = None
    ) -> SpotNode | None:
        deadline = asyncio.get_running_loop().time() + self.reservation_wait_seconds
        scaled = False
        task_ids = [task_id] if task_id else None
        while True:
            reservation = await self.pool_manager.reserve(1, task_ids=task_ids)
            if reservation.node_ids:
                node_id = reservation.node_ids[0]
                if node_id in exclude:
                    # We already tried this node and failed — release and
                    # try again so the pool can hand us a different one.
                    await self.pool_manager.release((node_id,))
                else:
                    node = self.pool_manager.get_node(node_id)
                    if node is not None:
                        return node
                    # Node disappeared between reserve and lookup — release.
                    await self.pool_manager.release((node_id,))

            if not scaled and self.scale_on_starvation:
                # Ask the pool to scale up by one so subsequent polls can
                # find a ready node. Bounded by SpotPoolConfig.max_nodes.
                try:
                    await self.pool_manager.scale_for(1)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("scale_for(1) raised: %s", exc)
                scaled = True

            if asyncio.get_running_loop().time() >= deadline:
                return None
            await asyncio.sleep(self.reservation_poll_interval_seconds)

    async def _mark_node_failed(self, node_id: str, reason: str) -> None:
        try:
            await self.pool_manager.mark_node_failed(node_id, reason)
        except Exception as exc:  # noqa: BLE001
            logger.warning("mark_node_failed(%s) raised: %s", node_id, exc)
