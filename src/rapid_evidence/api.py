from __future__ import annotations

import asyncio
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from rapid_evidence.batches import BatchExecutor, BatchRegistry
from rapid_evidence.core.models import FetchRequest
from rapid_evidence.core.time import utc_now_iso
from rapid_evidence.jobs import BackgroundJobRegistry, run_tracked
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
from rapid_evidence.spot.regions import (
    DEFAULT_REGIONS,
    probe_regions,
    request_quota_increase,
)
from rapid_evidence.spot.scheduler import SpotVmScheduler
from rapid_evidence.spot.sizing import estimate_spot_capacity
from rapid_evidence.storage.filesystem import FileSystemResultSink
from rapid_evidence.worker import (
    HttpWorkerTransport,
    InMemoryWorkerTransport,
    RemoteWorkerSource,
    WorkerTransport,
)


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
    quota_refresh = _env_float("RAPID_EVIDENCE_QUOTA_REFRESH_SECONDS", 60.0)
    return SpotPoolManager(
        scheduler=scheduler,
        heartbeat_interval=_env_float("RAPID_EVIDENCE_HEARTBEAT_SECONDS", 15.0),
        reconcile_interval=_env_float("RAPID_EVIDENCE_RECONCILE_SECONDS", 30.0),
        event_buffer=_env_int("RAPID_EVIDENCE_EVENT_BUFFER", 200),
        quota_refresh_interval_seconds=quota_refresh if quota_refresh > 0 else None,
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


def default_worker_transport_factory(provider) -> WorkerTransport:
    """Pick a WorkerTransport that matches the active Spot provider.

    - `in-memory`: returns `InMemoryWorkerTransport` with a configurable
      simulated latency so the dashboard demo shows real throughput.
    - `azure-cli`: returns `HttpWorkerTransport` keyed on the provider's
      shared secret. The agent is installed via cloud-init.
    """
    provider_name = getattr(provider, "provider_name", "unknown")
    if provider_name == "azure-cli":
        return HttpWorkerTransport(
            shared_secret=provider.agent_shared_secret,
            agent_port=provider.agent_port,
            scheme=os.environ.get("RAPID_EVIDENCE_AGENT_SCHEME", "http"),
            connect_timeout_seconds=_env_float(
                "RAPID_EVIDENCE_AGENT_CONNECT_TIMEOUT_SECONDS", 5.0
            ),
            request_timeout_seconds=_env_float(
                "RAPID_EVIDENCE_AGENT_REQUEST_TIMEOUT_SECONDS", 120.0
            ),
        )
    # in-memory / unknown — fall back to the in-process echo transport
    # so the developer loop and tests do not need real VMs.
    return InMemoryWorkerTransport(
        simulated_delay_seconds=_env_float(
            "RAPID_EVIDENCE_AGENT_DEMO_LATENCY_SECONDS", 0.0
        ),
    )


def build_batch_registry(
    *,
    source_client_factory=None,
    sink_factory=None,
    default_workers: int | None = None,
    pool_manager: SpotPoolManager | None = None,
    worker_transport: WorkerTransport | None = None,
) -> BatchRegistry:
    # Resolve through the module globals so tests can monkeypatch the
    # default factory after import.
    factory = source_client_factory or default_source_client_factory
    sink_builder = sink_factory or default_result_sink
    sink = sink_builder()
    workers = default_workers or _env_int("RAPID_EVIDENCE_BATCH_WORKERS", 4)
    remote_enabled = (
        pool_manager is not None
        and worker_transport is not None
        and _env_bool("RAPID_EVIDENCE_REMOTE_DISPATCH", True)
    )

    def executor_factory(source: str) -> BatchExecutor:
        if remote_enabled:
            policy = default_policy_store().require(source)
            source_client = RemoteWorkerSource(
                pool_manager=pool_manager,
                transport=worker_transport,
                max_attempts=max(1, policy.max_attempts),
                max_body_bytes=policy.max_request_bytes,
                request_timeout_seconds=_env_float(
                    "RAPID_EVIDENCE_FETCH_TIMEOUT_SECONDS", 30.0
                ),
                reservation_wait_seconds=_env_float(
                    "RAPID_EVIDENCE_RESERVE_WAIT_SECONDS", 30.0
                ),
            )
        else:
            source_client = factory(source)
        return BatchExecutor(source_client=source_client, sink=sink)

    return BatchRegistry(executor_factory=executor_factory, default_workers=workers)


@asynccontextmanager
async def lifespan(app: FastAPI):
    autostart = _env_bool("RAPID_EVIDENCE_POOL_AUTOSTART", True)
    manager: SpotPoolManager | None = None
    transport: WorkerTransport | None = None
    if autostart:
        manager = build_pool_manager()
        try:
            await manager.start()
        except Exception:
            await manager.stop()
            raise
        try:
            transport = default_worker_transport_factory(manager.scheduler.provider)
        except Exception:
            await manager.stop()
            raise
    app.state.pool_manager = manager
    app.state.worker_transport = transport

    registry = build_batch_registry(
        pool_manager=manager,
        worker_transport=transport,
    )
    app.state.batch_registry = registry

    jobs = BackgroundJobRegistry(
        max_jobs=_env_int("RAPID_EVIDENCE_JOBS_MAX", 100),
    )
    app.state.jobs = jobs

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

    eviction_task: asyncio.Task[None] | None = None
    if manager is not None:
        eviction_task = asyncio.create_task(
            _drain_evictions_loop(
                manager,
                registry,
                interval_seconds=_env_float(
                    "RAPID_EVIDENCE_EVICTION_DRAIN_INTERVAL_SECONDS", 2.0
                ),
            ),
            name="rapid-evidence-eviction-drain",
        )
    app.state.eviction_drain_task = eviction_task

    region_scan_task: asyncio.Task[None] | None = None
    region_scan_interval = _env_float(
        "RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS", 86400.0
    )
    if region_scan_interval > 0:
        region_scan_task = asyncio.create_task(
            _region_scan_loop(
                jobs=jobs,
                interval_seconds=region_scan_interval,
                initial_delay_seconds=_env_float(
                    "RAPID_EVIDENCE_REGION_SCAN_INITIAL_DELAY_SECONDS", 5.0
                ),
                spot_quota_name=os.environ.get(
                    "RAPID_EVIDENCE_AZURE_SPOT_QUOTA_NAME", "standardDASv5Family"
                ),
                regions=_parse_regions_env(),
            ),
            name="rapid-evidence-region-scan",
        )
    app.state.region_scan_task = region_scan_task

    try:
        yield
    finally:
        if region_scan_task is not None:
            region_scan_task.cancel()
            try:
                await region_scan_task
            except (asyncio.CancelledError, Exception):
                pass
        if eviction_task is not None:
            eviction_task.cancel()
            try:
                await eviction_task
            except (asyncio.CancelledError, Exception):
                pass
        await collector.stop()
        await registry.stop_all()
        if transport is not None:
            try:
                await transport.aclose()
            except Exception:
                pass
        if manager is not None:
            await manager.stop()
        app.state.metrics_collector = None
        app.state.batch_registry = None
        app.state.pool_manager = None
        app.state.worker_transport = None
        app.state.eviction_drain_task = None
        app.state.region_scan_task = None
        app.state.jobs = None


async def _drain_evictions_loop(
    manager: SpotPoolManager,
    registry: BatchRegistry,
    *,
    interval_seconds: float,
) -> None:
    """Forward EvictionEvent.requeue_task_ids to the batch registry.

    Runs forever; cancelled by the lifespan shutdown. Each iteration
    drains the manager's eviction buffer in O(1) (it is a deque under
    the hood) and routes the affected request IDs to whichever batch
    they belong to via `registry.notify_eviction`. The RemoteWorkerSource
    is what actually retries the fetch on a different node; this loop
    only exists so the UI can flag instability.
    """
    interval = max(0.25, interval_seconds)
    while True:
        try:
            events = manager.drain_eviction_events()
            for event in events:
                if not event.requeue_task_ids:
                    continue
                registry.notify_eviction(
                    requeue_task_ids=event.requeue_task_ids,
                    reason=event.reason,
                )
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).warning(
                "eviction drain loop iteration failed: %s", exc
            )
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise


def _parse_regions_env() -> tuple[str, ...] | None:
    raw = os.environ.get("RAPID_EVIDENCE_AZURE_REGIONS", "").strip()
    if not raw:
        return None
    parts = [r.strip() for r in re.split(r"[\s,;]+", raw) if r.strip()]
    return tuple(parts) if parts else None


async def _region_scan_loop(
    *,
    jobs: BackgroundJobRegistry,
    interval_seconds: float,
    initial_delay_seconds: float,
    spot_quota_name: str,
    regions: tuple[str, ...] | None,
) -> None:
    """Periodic all-region quota scan, tracked as background jobs.

    Default cadence is 24 hours per the requirement; configurable via
    `RAPID_EVIDENCE_REGION_SCAN_INTERVAL_SECONDS`. The first run is
    delayed slightly so the dashboard does not block startup on `az`.

    After every scan we open one `quota-increase-suggestion` job per
    region flagged as insufficient. Azure does not let `az` submit
    spot vCPU support tickets directly, so the job result is a
    structured *manual* plan — but recording it here means the
    dashboard surfaces an actionable next step instead of the operator
    needing to dig through the scan result.
    """
    interval = max(60.0, interval_seconds)
    if interval_seconds > 0 and interval_seconds < 60.0:
        logging.getLogger(__name__).warning(
            "region scan interval %.1fs is below the 60s floor; using 60s",
            interval_seconds,
        )
    try:
        await asyncio.sleep(max(0.0, initial_delay_seconds))
    except asyncio.CancelledError:
        raise
    while True:
        try:
            _, result = await run_tracked(
                jobs,
                "azure-region-quota-scan",
                lambda: probe_regions(
                    regions=regions, spot_quota_name=spot_quota_name
                ),
                metadata={
                    "regions": list(regions) if regions else list(DEFAULT_REGIONS),
                    "spot_quota_name": spot_quota_name,
                    "schedule": "periodic",
                    "interval_seconds": interval,
                },
            )
            if result is not None:
                _emit_quota_increase_suggestions(
                    jobs=jobs,
                    report=result,
                    spot_quota_name=spot_quota_name,
                )
        except Exception as exc:  # noqa: BLE001
            logging.getLogger(__name__).warning(
                "region scan loop iteration failed: %s", exc
            )
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise


def _emit_quota_increase_suggestions(
    *,
    jobs: BackgroundJobRegistry,
    report,
    spot_quota_name: str,
) -> None:
    """Record one suggestion job per insufficient region.

    Defensive: this function never raises into the scan loop. A bad
    `report` shape just yields zero suggestions.
    """
    insufficient = getattr(report, "insufficient_regions", None) or []
    if not insufficient:
        return
    region_probes = {p.region: p for p in (getattr(report, "regions", None) or [])}
    for region in insufficient:
        probe = region_probes.get(region)
        if probe is None or probe.limit is None:
            continue
        # Suggest doubling the current limit, clamped to the same
        # sane upper bound as request_quota_increase().
        new_limit = max(probe.limit * 2, probe.limit + 8)
        new_limit = min(new_limit, 100_000)
        try:
            plan = request_quota_increase(
                region,
                spot_quota_name=spot_quota_name,
                new_limit=new_limit,
            )
        except ValueError:
            continue
        job = jobs.start(
            f"quota-increase-suggestion-{region}",
            metadata={
                "region": region,
                "spot_quota_name": spot_quota_name,
                "current_used": probe.used,
                "current_limit": probe.limit,
                "suggested_new_limit": new_limit,
                "trigger": "periodic-region-scan",
            },
        )
        jobs.finish(job.job_id, status="succeeded", result=plan)


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def _no_store_for_realtime(request: Request, call_next):
    """Stop intermediaries from caching live dashboard snapshots.

    The dashboard polls these endpoints every few seconds; a stale
    cache layer (browser disk cache, corporate proxy, electron
    wrapper) returning a 30-second-old snapshot looks like a frozen
    UI. `Cache-Control: no-store` is the safest opt-out.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith(
        (
            "/dashboard",
            "/batches",
            "/metrics",
            "/quota",
            "/regions",
            "/scaling",
            "/jobs",
            "/events",
            "/pool",
            "/health",
        )
    ):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


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
            "nodes": snap.get("nodes", []),
            "recent_evictions": snap.get("recent_evictions", []),
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


# ----- scaffold endpoints for the disabled-pages session ------------------
# Each endpoint returns a safe snapshot (or empty list) so the new
# sidebar pages render without errors. The follow-up sessions own the
# actual logic; do not embed business behaviour here.

_SCALING_EVENT_TYPES = frozenset(
    {
        "node_provisioned",
        "node_evicted",
        "scale_up",
        "scale_down",
        "node_replaced",
    }
)


@app.get("/events")
def list_events(request: Request, since: str | None = None, limit: int = 200):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        return {"events": []}
    events = manager.snapshot().get("recent_events", []) or []
    if since:
        events = [e for e in events if (e.get("timestamp") or "") > since]
    # `limit` bounds payload size; clamp to a sane window.
    bounded = max(1, min(int(limit), 1000))
    return {"events": events[-bounded:]}


@app.get("/scaling/timeline")
def scaling_timeline(request: Request, window_seconds: float = 3600.0):
    collector: MetricsCollector | None = getattr(
        request.app.state, "metrics_collector", None
    )
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    samples = (
        [s.to_dict() for s in collector.query(window_seconds)]
        if collector is not None
        else []
    )
    events: list[dict[str, Any]] = []
    if manager is not None and manager.running:
        recent = manager.snapshot().get("recent_events", []) or []
        events = [e for e in recent if e.get("event_type") in _SCALING_EVENT_TYPES]
    return {"window_seconds": window_seconds, "samples": samples, "events": events}


@app.get("/quota/status")
def quota_status(request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        return {"observed": False}
    quota = manager.snapshot().get("quota")
    if quota is None:
        return {"observed": False}
    return {"observed": True, **quota}


@app.get("/regions/status")
def regions_status(request: Request):
    manager: SpotPoolManager | None = getattr(request.app.state, "pool_manager", None)
    if manager is None or not manager.running:
        return {"regions": [], "as_of": utc_now_iso()}
    snap = manager.snapshot()
    nodes = snap.get("nodes", []) or []
    recent_evictions = snap.get("recent_evictions", []) or []
    evictions_by_node: dict[str, int] = {}
    for ev in recent_evictions:
        node_id = ev.get("node_id")
        if node_id:
            evictions_by_node[node_id] = evictions_by_node.get(node_id, 0) + 1
    buckets: dict[str | None, dict[str, Any]] = {}
    for node in nodes:
        metadata = node.get("metadata") or {}
        region = metadata.get("region") if isinstance(metadata, dict) else None
        bucket = buckets.setdefault(
            region,
            {"region": region, "nodes": 0, "ready": 0, "busy": 0, "evictions_recent": 0},
        )
        bucket["nodes"] += 1
        state = node.get("state")
        if state == "ready":
            bucket["ready"] += 1
        elif state == "busy":
            bucket["busy"] += 1
        bucket["evictions_recent"] += evictions_by_node.get(node.get("node_id"), 0)
    return {"regions": list(buckets.values()), "as_of": utc_now_iso()}


@app.get("/jobs")
def jobs_list(request: Request, limit: int = 50):
    jobs: BackgroundJobRegistry | None = getattr(request.app.state, "jobs", None)
    if jobs is None:
        return {"jobs": []}
    cap = max(1, min(limit, 500))
    return {"jobs": [j.to_dict() for j in jobs.list(limit=cap)]}


@app.get("/jobs/{job_id}")
def jobs_get(job_id: str, request: Request):
    jobs: BackgroundJobRegistry | None = getattr(request.app.state, "jobs", None)
    if jobs is None:
        raise HTTPException(status_code=404, detail="jobs registry not initialised")
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.to_dict()


class QuotaProbeRequest(BaseModel):
    regions: list[str] | None = None
    spot_quota_name: str = "standardDASv5Family"
    requested_per_region: int = 1
    max_parallelism: int = 8
    per_region_timeout_seconds: float = 20.0

    @field_validator("requested_per_region")
    @classmethod
    def _check_requested(cls, v: int) -> int:
        if v < 1 or v > 10_000:
            raise ValueError("requested_per_region must be in [1, 10000]")
        return v

    @field_validator("max_parallelism")
    @classmethod
    def _check_parallelism(cls, v: int) -> int:
        if v < 1 or v > 64:
            raise ValueError("max_parallelism must be in [1, 64]")
        return v

    @field_validator("per_region_timeout_seconds")
    @classmethod
    def _check_timeout(cls, v: float) -> float:
        if v <= 0 or v > 600:
            raise ValueError("per_region_timeout_seconds must be in (0, 600]")
        return v


@app.post("/quota/probe-regions", status_code=202)
async def quota_probe_regions(payload: QuotaProbeRequest, request: Request):
    jobs: BackgroundJobRegistry | None = getattr(request.app.state, "jobs", None)
    if jobs is None:
        raise HTTPException(status_code=503, detail="jobs registry not initialised")
    regions_tuple = tuple(payload.regions) if payload.regions else None
    # Validate before we ever start the job so the operator gets a 400
    # synchronously instead of a generic 500 / failed job record.
    try:
        from rapid_evidence.spot.regions import _QUOTA_NAME_RE, _REGION_RE

        if regions_tuple is not None:
            bad = [r for r in regions_tuple if not _REGION_RE.match(r)]
            if bad:
                raise ValueError(f"invalid Azure region names: {bad!r}")
        if not _QUOTA_NAME_RE.match(payload.spot_quota_name):
            raise ValueError(f"invalid spot_quota_name: {payload.spot_quota_name!r}")
        if payload.max_parallelism < 1 or payload.max_parallelism > 64:
            raise ValueError("max_parallelism must be in [1, 64]")
        if payload.per_region_timeout_seconds <= 0:
            raise ValueError("per_region_timeout_seconds must be positive")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job, _ = await run_tracked(
        jobs,
        "azure-region-quota-scan",
        lambda: probe_regions(
            regions=regions_tuple,
            spot_quota_name=payload.spot_quota_name,
            requested_per_region=payload.requested_per_region,
            max_parallelism=payload.max_parallelism,
            per_region_timeout_seconds=payload.per_region_timeout_seconds,
        ),
        metadata={
            "regions": list(regions_tuple or DEFAULT_REGIONS),
            "spot_quota_name": payload.spot_quota_name,
            "schedule": "manual",
        },
    )
    return job.to_dict()


class QuotaIncreaseRequest(BaseModel):
    region: str
    new_limit: int
    spot_quota_name: str = "standardDASv5Family"


@app.post("/quota/request-increase")
def quota_request_increase(payload: QuotaIncreaseRequest, request: Request):
    jobs: BackgroundJobRegistry | None = getattr(request.app.state, "jobs", None)
    try:
        plan = request_quota_increase(
            payload.region,
            spot_quota_name=payload.spot_quota_name,
            new_limit=payload.new_limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if jobs is not None:
        job = jobs.start(
            f"quota-increase-request-{payload.region}",
            metadata={
                "region": payload.region,
                "spot_quota_name": payload.spot_quota_name,
                "new_limit": payload.new_limit,
            },
        )
        jobs.finish(job.job_id, status="succeeded", result=plan)
        plan["job_id"] = job.job_id
    return plan


@app.get("/batches/{batch_id}/timeline")
def batch_timeline(batch_id: str, request: Request):
    registry = _require_registry(request)
    record = registry.get(batch_id)
    if record is None:
        raise HTTPException(status_code=404, detail="batch not found")
    history = getattr(record, "history", None) or []
    return {
        "events": [
            {
                "timestamp": getattr(e, "timestamp", None) or e.get("timestamp"),
                "event_type": getattr(e, "event_type", None) or e.get("event_type"),
                "payload": getattr(e, "payload", None) or e.get("payload", {}),
            }
            for e in history
        ],
    }
