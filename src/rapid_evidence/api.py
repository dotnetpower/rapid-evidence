from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from rapid_evidence.core.models import FetchRequest
from rapid_evidence.orchestrator.scheduler import SurgeOrchestrator
from rapid_evidence.policy.defaults import default_policy_store
from rapid_evidence.providers.local import LocalWorkerProvider
from rapid_evidence.queue.memory import MemoryRequestQueue
from rapid_evidence.sources.generic_http import GenericHttpSource
from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.manager import SpotPoolManager
from rapid_evidence.spot.models import SpotPoolConfig
from rapid_evidence.spot.scheduler import SpotVmScheduler
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
    try:
        yield
    finally:
        if manager is not None:
            await manager.stop()
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
