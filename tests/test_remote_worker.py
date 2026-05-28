"""Tests for the WorkerTransport implementations and RemoteWorkerSource."""

from __future__ import annotations

import asyncio

import pytest

from rapid_evidence.core.errors import SourceFetchError
from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.manager import SpotPoolManager
from rapid_evidence.spot.models import SpotNode, SpotNodeState, SpotPoolConfig
from rapid_evidence.spot.scheduler import SpotVmScheduler
from rapid_evidence.worker import (
    InMemoryWorkerTransport,
    RemoteWorkerSource,
    WorkerDispatchError,
    WorkerDispatchPayload,
    WorkerDispatchResult,
)


def _make_node(node_id: str = "node-1") -> SpotNode:
    return SpotNode(
        node_id=node_id,
        name=f"vm-{node_id}",
        state=SpotNodeState.READY,
        public_ip=f"203.0.113.{abs(hash(node_id)) % 250 + 1}",
        outbound_ip=f"198.51.100.{abs(hash(node_id)) % 250 + 1}",
    )


async def _build_started_manager(*, min_ready: int = 1, max_nodes: int = 4) -> SpotPoolManager:
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(
        provider=provider,
        config=SpotPoolConfig(min_ready=min_ready, max_nodes=max_nodes, per_node_concurrency=1),
    )
    manager = SpotPoolManager(
        scheduler=scheduler,
        heartbeat_interval=0.05,
        reconcile_interval=0.05,
    )
    await manager.start()
    for _ in range(60):
        ready = sum(1 for n in scheduler._nodes.values() if n.ready)
        if ready >= min_ready:
            break
        await asyncio.sleep(0.05)
    return manager


@pytest.mark.asyncio
async def test_inmemory_transport_default_handler_echoes_url():
    transport = InMemoryWorkerTransport()
    node = _make_node("node-1")
    payload = WorkerDispatchPayload(
        url="https://example.com/abc",
        headers={"User-Agent": "test"},
        method="GET",
        max_body_bytes=1024,
        timeout_seconds=5.0,
        max_attempts=1,
        request_id="req-1",
    )
    result = await transport.dispatch(node, payload)
    assert isinstance(result, WorkerDispatchResult)
    assert result.ok is True
    assert result.status_code == 200
    assert result.body and b"https://example.com/abc" in result.body
    assert result.node_id == "node-1"
    assert ("node-1", payload) in transport.dispatches


@pytest.mark.asyncio
async def test_inmemory_transport_handler_can_signal_failure():
    async def handler(node, payload):
        raise WorkerDispatchError("simulated network failure")

    transport = InMemoryWorkerTransport(handler=handler)
    with pytest.raises(WorkerDispatchError):
        await transport.dispatch(
            _make_node("node-x"),
            WorkerDispatchPayload(
                url="https://example.com/",
                headers={},
                method="GET",
                max_body_bytes=1024,
                timeout_seconds=5.0,
                max_attempts=1,
                request_id="req-x",
            ),
        )


@pytest.mark.asyncio
async def test_inmemory_transport_simulated_delay_blocks():
    transport = InMemoryWorkerTransport(simulated_delay_seconds=0.05)
    payload = WorkerDispatchPayload(
        url="https://example.com/",
        headers={},
        method="GET",
        max_body_bytes=1024,
        timeout_seconds=5.0,
        max_attempts=1,
        request_id="req-delay",
    )
    start = asyncio.get_event_loop().time()
    await transport.dispatch(_make_node("node-d"), payload)
    elapsed = asyncio.get_event_loop().time() - start
    assert elapsed >= 0.04


@pytest.mark.asyncio
async def test_remote_worker_source_happy_path():
    manager = await _build_started_manager(min_ready=1, max_nodes=2)
    transport = InMemoryWorkerTransport()
    source = RemoteWorkerSource(
        pool_manager=manager,
        transport=transport,
        max_attempts=2,
        reservation_wait_seconds=2.0,
    )
    try:
        result = await source.fetch_async("https://example.com/x", request_id="req-1")
        assert result["ok"] is True
        assert result["status"] == 200
        assert result["node_id"]
        assert result["attempts"] == 1
        assert result["body"]
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_remote_worker_source_retries_on_first_node_failure():
    manager = await _build_started_manager(min_ready=2, max_nodes=4)
    for _ in range(60):
        ready = sum(1 for n in manager.scheduler._nodes.values() if n.ready)
        if ready >= 2:
            break
        await asyncio.sleep(0.05)

    invocations: list[str] = []

    async def handler(node, payload):
        invocations.append(node.node_id)
        if len(invocations) == 1:
            raise WorkerDispatchError(f"node {node.node_id} simulated failure")
        return WorkerDispatchResult(
            ok=True,
            status_code=200,
            body=b"ok",
            attempts=1,
            outbound_ip=node.outbound_ip,
            node_id=node.node_id,
            error=None,
        )

    transport = InMemoryWorkerTransport(handler=handler)
    source = RemoteWorkerSource(
        pool_manager=manager,
        transport=transport,
        max_attempts=3,
        reservation_wait_seconds=2.0,
    )
    try:
        result = await source.fetch_async("https://example.com/y", request_id="req-2")
        assert result["ok"] is True
        assert result["node_id"]
        # The retry must have come from a different node than the failed one.
        assert len(invocations) == 2
        assert invocations[0] != invocations[1]
    finally:
        await manager.stop()


@pytest.mark.asyncio
async def test_remote_worker_source_raises_when_no_nodes_available():
    provider = InMemorySpotVmProvider()
    scheduler = SpotVmScheduler(
        provider=provider,
        config=SpotPoolConfig(min_ready=0, max_nodes=1, per_node_concurrency=1),
    )
    manager = SpotPoolManager(
        scheduler=scheduler,
        heartbeat_interval=10.0,
        reconcile_interval=10.0,
    )
    await manager.start()
    transport = InMemoryWorkerTransport()
    source = RemoteWorkerSource(
        pool_manager=manager,
        transport=transport,
        max_attempts=1,
        reservation_wait_seconds=0.3,
        reservation_poll_interval_seconds=0.05,
        scale_on_starvation=False,
    )
    try:
        with pytest.raises(SourceFetchError):
            await source.fetch_async("https://example.com/", request_id="req-3")
    finally:
        await manager.stop()
