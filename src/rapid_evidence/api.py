import re

from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from rapid_evidence.core.models import FetchRequest
from rapid_evidence.orchestrator.scheduler import SurgeOrchestrator
from rapid_evidence.policy.defaults import default_policy_store
from rapid_evidence.providers.local import LocalWorkerProvider
from rapid_evidence.queue.memory import MemoryRequestQueue
from rapid_evidence.sources.generic_http import GenericHttpSource
from rapid_evidence.storage.filesystem import FileSystemResultSink


app = FastAPI()


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


def _execute_batch(request: RunRequest) -> RunResponse:
    urls, duplicate_count = _split_urls(request.urls)
    policies = default_policy_store()
    policy = policies.require(request.source)
    queue = MemoryRequestQueue(max_queued=1024)
    for url in urls:
        req = FetchRequest(target=url, source=request.source, headers={"User-Agent": "rapid-evidence"})
        policy.validate_request(req)
        queue.enqueue(req)
    sink = FileSystemResultSink(".rapid-evidence")
    provider = LocalWorkerProvider()
    source_client = GenericHttpSource(max_body_bytes=policy.max_request_bytes, timeout_seconds=30.0, max_attempts=policy.max_attempts)
    orchestrator = SurgeOrchestrator(policies=policies, limits=type("Limits", (), {"max_workers": request.max_vm, "runtime_seconds": 60.0, "max_budget_usd": 0.0, "estimated_worker_second_usd": 0.0})())
    plan = orchestrator.run_local_once(request.source, queue, sink, provider, source_client)
    return RunResponse(
        valid_count=len(urls),
        duplicate_count=duplicate_count,
        results=[{"url": url, "status": "queued"} for url in urls],
        pool={"min_vm": request.min_vm, "max_vm": request.max_vm, "running": plan.target_workers, "idle": max(0, request.min_vm), "provisioning": 0, "terminating": 0},
    )


@app.post("/run")
async def run(payload: RunRequest):
    return await run_in_threadpool(_execute_batch, payload)


@app.get("/health")
def health():
    return {"ok": True}
