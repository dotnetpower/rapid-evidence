from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from rapid_evidence.batches import BatchExecutor, BatchRegistry
from rapid_evidence.core.models import FetchRequest
from rapid_evidence.metrics import MetricsCollector
from rapid_evidence.metrics.collector import build_metric_sample
from rapid_evidence.orchestrator.scheduler import SurgeOrchestrator
from rapid_evidence.policy.defaults import default_policy_store
from rapid_evidence.providers.local import LocalWorkerProvider
from rapid_evidence.queue.memory import MemoryRequestQueue
from rapid_evidence.sources.generic_http import GenericHttpSource
from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.manager import SpotPoolManager
from rapid_evidence.spot.models import SpotNodeState, SpotPoolConfig
from rapid_evidence.spot.scheduler import SpotVmScheduler
from rapid_evidence.spot.sizing import estimate_spot_capacity
from rapid_evidence.storage.filesystem import FileSystemResultSink


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a float, got {raw!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _build_pool_config() -> SpotPoolConfig:
    return SpotPoolConfig(
        min_ready=_env_int("RAPID_EVIDENCE_SPOT_MIN_READY", 1),
        max_nodes=_env_int("RAPID_EVIDENCE_SPOT_MAX_NODES", 4),
        per_node_concurrency=_env_int("RAPID_EVIDENCE_SPOT_PER_NODE", 1),
        idle_timeout_seconds=_env_int("RAPID_EVIDENCE_SPOT_IDLE_TIMEOUT", 600),
    )


def _build_provider():
    provider_name = os.environ.get("RAPID_EVIDENCE_SPOT_PROVIDER", "in-memory").strip().lower()
    if provider_name == "azure-cli":
        from rapid_evidence.spot.azure_cli_provider import (
            AzureCliSpotVmProvider,
            AzureSpotVmConfig,
        )

        return AzureCliSpotVmProvider(
            AzureSpotVmConfig(
                location=os.environ.get("RAPID_EVIDENCE_AZURE_REGION", "koreacentral"),
                resource_group=os.environ.get(
                    "RAPID_EVIDENCE_AZURE_RESOURCE_GROUP", "rapid-evidence"
                ),
                vm_size=os.environ.get("RAPID_EVIDENCE_AZURE_VM_SIZE", "Standard_D2as_v5"),
            )
        )
    return InMemorySpotVmProvider()


def build_pool_manager() -> SpotPoolManager:
    config = _build_pool_config()
    provider = _build_provider()
    scheduler = SpotVmScheduler(provider=provider, config=config)
    return SpotPoolManager(
        scheduler=scheduler,
        heartbeat_interval=_env_float("RAPID_EVIDENCE_HEARTBEAT_SECONDS", 15.0),
        reconcile_interval=_env_float("RAPID_EVIDENCE_RECONCILE_SECONDS", 30.0),
    )


def default_source_client_factory(source: str) -> Any:
    """Build a source client for the batch executor.

    Defaults to GenericHttpSource governed by the registered policy. Tests
    monkeypatch this to return a fake client that does not perform real HTTP.
    """
    policy = default_policy_store().require(source)
    return GenericHttpSource(
        max_body_bytes=policy.max_request_bytes,
        timeout_seconds=_env_float("RAPID_EVIDENCE_FETCH_TIMEOUT_SECONDS", 30.0),
        max_attempts=policy.max_attempts,
    )


def default_result_sink() -> FileSystemResultSink:
    return FileSystemResultSink(
        os.environ.get("RAPID_EVIDENCE_RESULT_DIR", ".rapid-evidence")
    )


def build_batch_registry(
    *,
    source_client_factory=None,
    sink_factory=None,
    default_workers: int | None = None,
) -> BatchRegistry:
    # Resolve through the module globals so tests can monkeypatch the
    # default factory after import.
    factory = source_client_factory or default_source_client_factory
    sink_builder = sink_factory or default_result_sink
    sink = sink_builder()
    workers = default_workers or _env_int("RAPID_EVIDENCE_BATCH_WORKERS", 4)

    def executor_factory(source: str) -> BatchExecutor:
        return BatchExecutor(source_client=factory(source), sink=sink)

    return BatchRegistry(executor_factory=executor_factory, default_workers=workers)


@asynccontextmanager
async def lifespan(app: FastAPI):
    autostart = _env_bool("RAPID_EVIDENCE_POOL_AUTOSTART", True)
    manager: SpotPoolManager | None = None
    if autostart:
        manager = build_pool_manager()
        try:
            await manager.start()
        except Exception:
            await manager.stop()
            raise
    app.state.pool_manager = manager

    registry = build_batch_registry()
    app.state.batch_registry = registry

    def _snapshot() -> Any:
        counters: dict[str, int] = {}
        if manager is not None and manager.running:
            counters = manager.snapshot().get("counters", {})
        return build_metric_sample(
            backlog=registry.backlog(),
            throughput_per_second=registry.aggregate_throughput_per_second(),
            counters=counters,
            active_batches=registry.active_batch_count(),
        )

    collector = MetricsCollector(
        snapshot=_snapshot,
        sample_interval_seconds=_env_float("RAPID_EVIDENCE_METRICS_INTERVAL_SECONDS", 5.0),
        retention_seconds=_env_float("RAPID_EVIDENCE_METRICS_RETENTION_SECONDS", 3600.0),
    )
    await collector.start()
    app.state.metrics_collector = collector

    try:
        yield
    finally:
        await collector.stop()
        await registry.stop_all()
        if manager is not None:
            await manager.stop()
        app.state.metrics_collector = None
        app.state.batch_registry = None
        app.state.pool_manager = None


app = FastAPI(lifespan=lifespan)


class RunRequest(BaseModel):
    urls: str | list[str]
    min_vm: int = 1
    max_vm: int = 4
    batch_size: int = 4
    source: str = "generic-http"


class RunResponse(BaseModel):
    valid_count: int
    duplicate_count: int
    results: list[dict]
    pool: dict


class ScaleRequest(BaseModel):
    requested_tasks: int


def _split_urls(text: str | list[str]) -> tuple[list[str], int]:
    if isinstance(text, list):
        raw = text
    else:
        raw = re.split(r"[\n,;\t\s]+", text.strip())
    cleaned = []
    seen = set()
    dupes = 0
    for item in raw:
        value = item.strip()
        if not value:
            continue
        if value in seen:
            dupes += 1
            continue
        seen.add(value)
        cleaned.append(value)
    return cleaned, dupes


def _pool_field(
    manager: SpotPoolManager | None, request: RunRequest, plan_workers: int
) -> dict[str, Any]:
    base = {
        "min_vm": request.min_vm,
        "max_vm": request.max_vm,
        "running": plan_workers,
        "idle": max(0, request.min_vm),
        "provisioning": 0,
        "terminating": 0,
    }
    if manager is not None and manager.running:
        snap = manager.snapshot()
        counters = snap["counters"]
        base.update(
            {
                "running": counters.get("busy", 0),
                "idle": counters.get("ready", 0),
                "provisioning": counters.get("provisioning", 0),
                "terminating": counters.get("terminating", 0),
                "evicted_total": snap["metrics"].get("evictions_total", 0),
                "replaced_total": snap["metrics"].get("nodes_replaced_total", 0),
                "heartbeats": snap["metrics"].get("heartbeat_count", 0),
                "provider": snap.get("provider"),
            }
        )
    return base


def _execute_batch(request: RunRequest, manager: SpotPoolManager | None) -> RunResponse:
    urls, duplicate_count = _split_urls(request.urls)
    policies = default_policy_store()
    policy = policies.require(request.source)
    queue = MemoryRequestQueue(max_queued=1024)
    for url in urls:
        req = FetchRequest(
            target=url, source=request.source, headers={"User-Agent": "rapid-evidence"}
        )
        policy.validate_request(req)
        queue.enqueue(req)
    sink = FileSystemResultSink(".rapid-evidence")
    provider = LocalWorkerProvider()
    source_client = GenericHttpSource(
        max_body_bytes=policy.max_request_bytes,
        timeout_seconds=30.0,
        max_attempts=policy.max_attempts,
    )
    orchestrator = SurgeOrchestrator(
        policies=policies,
        limits=type(
            "Limits",
            (),
            {
                "max_workers": request.max_vm,
                "runtime_seconds": 60.0,
                "max_budget_usd": 0.0,
                "estimated_worker_second_usd": 0.0,
            },
        )(),
    )
    plan = orchestrator.run_local_once(request.source, queue, sink, provider, source_client)
    return RunResponse(
        valid_count=len(urls),
        duplicate_count=duplicate_count,
        results=[{"url": url, "status": "queued"} for url in urls],
        pool=_pool_field(manager, request, plan.target_workers),
    )


@app.post("/run")
async def run(payload: RunRequest, request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is not None and manager.running:
        # Best-effort: ask the pool to grow toward demand. Fetch work
        # itself still runs against the local in-process worker; pool
        # readiness is reported back in the `pool` field.
        await manager.scale_for(len(_split_urls(payload.urls)[0]))
    return await run_in_threadpool(_execute_batch, payload, manager)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/pool/status")
def pool_status(request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None:
        return {"running": False, "reason": "pool autostart disabled"}
    return manager.snapshot()


@app.post("/pool/scale")
async def pool_scale(payload: ScaleRequest, request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        raise HTTPException(status_code=503, detail="pool manager not running")
    plan = await manager.scale_for(payload.requested_tasks)
    return {
        "requested_tasks": payload.requested_tasks,
        "plan": {
            "immediate_tasks": plan.immediate_tasks,
            "queued_tasks": plan.queued_tasks,
            "overflow_tasks": plan.overflow_tasks,
            "target_nodes": plan.target_nodes,
            "scale_up_nodes": plan.scale_up_nodes,
            "scale_down_nodes": plan.scale_down_nodes,
        },
        "snapshot": manager.snapshot(),
    }


@app.post("/pool/heartbeat")
async def pool_heartbeat(request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        raise HTTPException(status_code=503, detail="pool manager not running")
    events = await manager.heartbeat_once()
    return {
        "new_evictions": [
            {
                "node_id": e.node_id,
                "public_ip": e.public_ip,
                "reason": e.reason,
                "requeue_task_ids": list(e.requeue_task_ids),
            }
            for e in events
        ],
        "snapshot": manager.snapshot(),
    }


@app.post("/pool/reconcile")
async def pool_reconcile(request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        raise HTTPException(status_code=503, detail="pool manager not running")
    result = await manager.reconcile_once()
    return {"result": result, "snapshot": manager.snapshot()}


# ----- batches -----------------------------------------------------------


class BatchCreateRequest(BaseModel):
    source: str = "generic-http"
    targets: list[str] = Field(default_factory=list)
    workers: int | None = None
    headers: dict[str, str] | None = None
    metadata: dict[str, Any] | None = None


def _require_registry(request: Request) -> BatchRegistry:
    registry: BatchRegistry | None = getattr(request.app.state, "batch_registry", None)
    if registry is None:
        raise HTTPException(status_code=503, detail="batch registry not running")
    return registry


@app.post("/batches", status_code=201)
async def create_batch(payload: BatchCreateRequest, request: Request):
    registry = _require_registry(request)
    targets = [t for t in payload.targets if t and t.strip()]
    if not targets:
        raise HTTPException(status_code=422, detail="targets must not be empty")
    try:
        record = await registry.submit(
            source=payload.source,
            targets=targets,
            workers=payload.workers,
            headers=payload.headers,
            metadata=payload.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return record.progress().to_dict()


@app.get("/batches")
def list_batches(request: Request):
    registry = _require_registry(request)
    return {"batches": [p.to_dict() for p in registry.list_progress()]}


@app.get("/batches/{batch_id}")
def get_batch(batch_id: str, request: Request):
    registry = _require_registry(request)
    progress = registry.progress(batch_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="batch not found")
    return progress.to_dict()


@app.post("/batches/{batch_id}/cancel")
async def cancel_batch(batch_id: str, request: Request):
    registry = _require_registry(request)
    progress = await registry.cancel(batch_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="batch not found")
    return progress.to_dict()


# ----- metrics -----------------------------------------------------------


@app.get("/metrics/timeseries")
def metrics_timeseries(request: Request, window_seconds: float | None = None):
    collector: MetricsCollector | None = getattr(
        request.app.state, "metrics_collector", None
    )
    if collector is None:
        raise HTTPException(status_code=503, detail="metrics collector not running")
    samples = collector.query(window_seconds)
    return {
        "window_seconds": window_seconds,
        "sample_interval_seconds": collector.sample_interval_seconds,
        "retention_seconds": collector.retention_seconds,
        "samples": [s.to_dict() for s in samples],
    }


# ----- dashboard summary -------------------------------------------------


def _compute_scale_up_target(
    manager: SpotPoolManager | None, backlog: int
) -> dict[str, int] | None:
    if manager is None or not manager.running:
        return None
    config = manager.scheduler.config
    nodes = manager.scheduler._nodes.values()
    ready_nodes = sum(1 for n in nodes if n.ready)
    active_nodes = sum(
        1
        for n in nodes
        if n.state
        in {
            SpotNodeState.READY,
            SpotNodeState.BUSY,
            SpotNodeState.PROVISIONING,
            SpotNodeState.DRAINING,
        }
    )
    plan = estimate_spot_capacity(
        config, max(0, backlog), ready_nodes, active_nodes, {}
    )
    return {
        "target_nodes": plan.target_nodes,
        "scale_up_nodes": plan.scale_up_nodes,
        "scale_down_nodes": plan.scale_down_nodes,
        "immediate_tasks": plan.immediate_tasks,
        "queued_tasks": plan.queued_tasks,
        "overflow_tasks": plan.overflow_tasks,
    }


@app.get("/dashboard/summary")
def dashboard_summary(request: Request):
    registry = _require_registry(request)
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    collector: MetricsCollector | None = getattr(
        request.app.state, "metrics_collector", None
    )

    backlog = registry.backlog()
    throughput = registry.aggregate_throughput_per_second()
    drain_eta = registry.drain_eta_seconds()
    active_batches = registry.active_batch_count()

    pool_block: dict[str, Any] = {"running": False}
    if manager is not None and manager.running:
        snap = manager.snapshot()
        pool_block = {
            "running": True,
            "provider": snap.get("provider"),
            "config": snap.get("config"),
            "counters": snap.get("counters"),
            "metrics": snap.get("metrics"),
        }

    latest = collector.latest() if collector is not None else None

    return {
        "backlog": backlog,
        "throughput_per_second": round(throughput, 3),
        "drain_eta_seconds": (
            round(drain_eta, 1) if drain_eta is not None else None
        ),
        "active_batches": active_batches,
        "pool": pool_block,
        "scale_target": _compute_scale_up_target(manager, backlog),
        "latest_sample": latest.to_dict() if latest is not None else None,
        "sample_interval_seconds": (
            collector.sample_interval_seconds if collector is not None else None
        ),
    }
