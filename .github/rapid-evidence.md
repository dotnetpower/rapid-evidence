# Prompt: Build `rapid_evidence` — a policy-governed burst evidence collection toolkit with Azure Spot VM warm pool

You are tasked with implementing a Python package called `rapid_evidence`. It is **not** a general scraper, **not** a rate-limit evasion tool, and **not** a generic worker framework. Read every section before writing code.

---

## 1. Mission

Provide a **policy-governed**, **auditable**, **bounded** toolkit that:

1. Fetches evidence (papers, public-health records, API documents) from external HTTP archives **only when a per-source policy explicitly permits it**.
2. Runs work inside a **warm pool of Azure Spot VMs** so each worker gets its own outbound IP — useful for sources that legitimately require one-real-IP-per-worker (rate-limit fairness, attribution, audit).
3. Treats **cloud cost, Spot eviction, and data loss as first-class concerns**, not afterthoughts.
4. Stays **operable on a single workstation with Azure CLI** — no managed control plane, no Kubernetes, no asyncio infection.

---

## 2. Non-Goals (do not build these)

- ❌ No anti-bot evasion, no fingerprint spoofing, no residential proxy integration.
- ❌ No managed services (no AKS, no ACI, no Functions). One pluggable provider for local execution + one for raw Azure Spot VMs via `az` CLI subprocess.
- ❌ No persistent database. The audit ledger is append-only JSONL; the warm pool state is in-memory + reattached via VM tags on restart.
- ❌ No asyncio. Use `concurrent.futures.ThreadPoolExecutor` for parallelism. The toolkit is synchronous and embeddable.
- ❌ No hidden ambient credentials. Authentication is whatever `az` is already logged in as.
- ❌ No “smart” auto-retry that hides quota / capacity / policy errors. Surface them, do not paper over them.

---

## 3. Package Layout

```
rapid_evidence/
├── core/         # ids, time, errors, FetchRequest/Result, SourcePolicy, SurgeLimits, WorkerLease/Spec
├── policy/       # PolicyStore, default_policy_store(), validate_request()
├── queue/        # MemoryRequestQueue with max_queued + dedupe + requeue_front()
├── sources/      # GenericHttpSource (bounded body, retry-after parsing, GuardedHTTPTransport) + url_guard (DNS-resolving SSRF guard)
├── providers/    # LocalWorkerProvider (in-process). Worker provider Protocol lives in base.py
├── orchestrator/ # SurgeOrchestrator: bounded fan-out, budget cap, runtime cap
├── storage/      # FileSystemResultSink (0700 dir, 0600 files, fsync)
├── audit/        # JsonlAuditLedger (append-only, fsync, 0600)
├── spot/         # Spot VM warm-pool (models, scheduler, provider Protocol, in-memory fake, Azure CLI provider, sizing)
└── cli.py        # rapidfetch: run-local | spot-plan | spot-quota
```

Tests live in `tests/`. Benchmarks live in `benchmarks/` and are **opt-in only** (never run from default CI).

---

## 4. Hard Architectural Rules

### 4.1 Policy gate — no policy, no work

- `PolicyStore.require(source)` raises if no `SourcePolicy` is registered.
- `SourcePolicy` defines: `min_delay_seconds`, `max_concurrency`, `max_batch_size`, `max_workers`, `required_headers`, `allowed_methods`, `max_attempts`, `retry_after_seconds`.
- Every `FetchRequest` is validated against the source policy before being enqueued.
- The CLI `run-local` and any orchestrator call refuses to schedule if `args.batch_size > policy.max_batch_size`.

### 4.2 Bounded everything

- `MemoryRequestQueue(max_queued=N)` rejects with `QueueCapacityError` past the cap.
- `GenericHttpSource(max_body_bytes=N)` uses `httpx.stream()` + `iter_bytes()` and truncates past the cap.
- `SurgeOrchestrator` has hard `max_workers`, `max_runtime_seconds`, `max_budget_usd`.

### 4.3 SSRF defense in depth

- Implement `validate_public_http_url(url)` that:
  - Resolves the hostname via DNS.
  - Rejects loopback, link-local, private, multicast, unspecified, reserved, broadcast, and IPv6 ULA addresses.
  - Allows IP literals only after the same checks.
- Install a `GuardedHTTPTransport` wrapper so **every redirect target** is re-validated at dispatch time (close the TOCTOU gap).
- DNS validation must happen at dispatch, not just at enqueue.

### 4.4 Storage / audit hygiene

- Result sink directories `0o700`, files `0o600`, `fsync` after write.
- `JsonlAuditLedger.record(event_type, payload)` is append-only (`O_WRONLY | O_CREAT | O_APPEND`), `fsync`’d, thread-locked.
- The audit ledger is *the* observability surface — there is no separate metrics system.

### 4.5 Source name normalization

- All source names are lowercased + stripped at the model boundary. The queue, policy store, and worker spec all use the normalized form.

### 4.6 Worker env var validation

- `WorkerSpec(env={...})` validates each key as `^[A-Z_][A-Z0-9_]*$`.

### 4.7 Numeric input validation in `__post_init__`

- Every dataclass with numeric fields (timeouts, retry budgets, batch sizes, pool sizes, idle thresholds, IP share thresholds) validates the value in `__post_init__` and raises `ValueError` with a precise message.

---

## 5. The Spot VM Warm Pool — the heart of the system

### 5.1 Why a warm pool

For sources that legitimately require one real outbound IP per worker (rate-limit fairness, attribution), you need actual VMs. Cold-creating a VM takes ~60–90s per `az vm create`. To stay responsive, keep a configurable number of nodes pre-warmed and report exactly what is available right now without blocking on cold provisioning.

### 5.2 Models

```python
class SpotNodeState(StrEnum):
    PROVISIONING, READY, BUSY, DRAINING, TERMINATING, TERMINATED, FAILED, EVICTED

@dataclass(frozen=True)
class SpotPoolConfig:
    min_ready: int = 3
    max_nodes: int = 20
    per_node_concurrency: int = 1
    scale_up_batch: int = 5
    scale_down_batch: int = 5
    ready_timeout_seconds: int = 300
    cleanup_retries: int = 3
    idle_timeout_seconds: int = 600
    idle_floor: int | None = None        # None → fall back to min_ready
    max_same_subnet_share: float = 0.5   # alert when >50% of nodes share a /24
    # __post_init__ validates every field

@dataclass(frozen=True)
class SpotNode:
    node_id: str        # logical, stable across SKU/zone retries
    name: str           # physical Azure VM name (unique per attempt)
    state: SpotNodeState
    public_ip: str | None
    outbound_ip: str | None
    inflight: int = 0
    vm_size: str | None = None
    zone: str | None = None
    metadata: dict = field(default_factory=dict)
    error: str | None = None
    # `active` excludes TERMINATED/FAILED/EVICTED
    # `ready` requires state==READY AND inflight==0

@dataclass(frozen=True) class SpotPoolStatus     # nodes + capacity_plan + ip_distribution
@dataclass(frozen=True) class SpotCapacityPlan   # immediate_tasks, queued_tasks, overflow_tasks, target_nodes, scale_up_nodes, scale_down_nodes, estimated_new_ready_seconds
@dataclass(frozen=True) class SpotReservation    # node_ids, assignments: dict[node_id, tuple[task_id, ...]], unassigned_task_ids
@dataclass(frozen=True) class EvictionEvent      # node_id, public_ip, reason, requeue_task_ids
@dataclass(frozen=True) class QuotaSnapshot      # used/limit pairs + spot_quota_observed + public_ip_quota_observed + is_sufficient
@dataclass(frozen=True) class IpDistribution     # total_with_ip, unique_subnets, largest_subnet_share, violates_max_share
@dataclass(frozen=True) class CleanupReport
```

### 5.3 Provider protocol

```python
class SpotVmProvider(Protocol):
    provider_name: str
    def create_nodes(self, count: int, config: SpotPoolConfig) -> tuple[SpotNode, ...]: ...
    def refresh_nodes(self) -> tuple[SpotNode, ...]: ...
    def terminate_nodes(self, node_ids: tuple[str, ...]) -> tuple[str, ...]: ...

# Optional extension a real provider should implement:
class SpotVmDiscoveryProvider(Protocol):
    def discover_existing_nodes(self) -> tuple[SpotNode, ...]: ...
    def check_quota(self, requested_nodes: int, config: SpotPoolConfig) -> QuotaSnapshot: ...

class SpotAuditSink(Protocol):
    def record(self, event_type: str, payload: dict) -> None: ...
```

### 5.4 Scheduler invariants

Implement `SpotVmScheduler(provider, config, audit_sink=None, now=...)` with these methods:

- `initialize()` → reattach via `discover_existing_nodes()` if the provider supports it, then `ensure_min_ready()`.
- `ensure_min_ready()` → **must auto-terminate FAILED nodes** (`_terminate_failed_from(nodes)`) so cost does not leak. Replenish until ready ≥ `min_ready`.
- `status(requested_tasks=0)` → returns a fast, non-blocking `SpotPoolStatus`. Capacity plan reports `immediate_tasks` based on **currently ready** nodes, never on “after we cold-start more.”
- `reserve(requested_tasks, task_ids=None)` → assigns only ready nodes; records task↔node bindings; returns `SpotReservation` with `assignments` and `unassigned_task_ids`. Reject with `ValueError` if `len(task_ids) != requested_tasks`.
- `release(node_ids)` → returns nodes to ready, drops assignments, audits.
- `detect_evictions(previous_nodes=None)` → emits `EvictionEvent`s for nodes that disappeared; the events carry the `requeue_task_ids` the caller must re-enqueue.
- `apply_idle_timeout()` → if no `BUSY` nodes and `idle_timeout_seconds` elapsed since the last `reserve()`, scale ready down to `effective_idle_floor`.
- `cleanup_all()` → retried termination of all active nodes.
- `evicted_events()` / `drain_evicted_events()` → read-only view + drain. The internal history list is bounded by a constant (e.g. 1024).

### 5.5 Critical scheduler rules (from hardening)

1. **No silent task drops.** `_refresh_overlay()` must detect assignments whose node disappeared and surface them as implicit `EvictionEvent`s. A caller that never calls `detect_evictions()` still recovers tasks via `drain_evicted_events()`.
2. **Single refresh per iteration.** Do not call `provider.refresh_nodes()` twice in the same `ensure_min_ready()` loop iteration. Pass the node list to `_terminate_failed_from(nodes)`.
3. **FAILED nodes are real money.** Auto-terminate them on every `ensure_min_ready()` pass.
4. **Eviction history is bounded.** `_evicted` must never grow without bound — cap at a constant (`_EVICTED_HISTORY_MAX`) and expose `drain_evicted_events()` for caller-side ack.
5. **Audit failures must not break scheduling.** Wrap the sink call in `try/except` and swallow.
6. **All state mutation happens under `_lock` (`RLock`).** No exception.

### 5.6 Azure CLI provider — what must hold

`AzureSpotVmConfig` knobs (defaults shown):

```python
location="koreacentral"
vm_size="Standard_D2as_v5"
vm_size_fallbacks=()                       # rotated automatically on capacity errors
availability_zones=()                      # optional ("1","2","3")
image="Ubuntu2204"
nsg_name="rapid-evidence-egress-only"
address_prefix="10.42.0.0/16"
subnet_prefix="10.42.0.0/24"
max_price_usd=-1.0                         # -1 means "pay market"
probe_urls=("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")
vcpus_per_vm=2
spot_quota_name="standardDASv5Family"
create_concurrency=10
probe_concurrency=10
cloud_init_enabled=True
```

#### 5.6.1 Infrastructure (idempotent)

`_ensure_infrastructure()` creates:

- Resource group at `location`.
- NSG with a single rule: deny-all-inbound (priority 4000, `*` everything). All `try/except` so re-runs against an existing RG do not crash.
- VNet + subnet, then attaches the NSG to the subnet.

Public IPs are Standard SKU, Spot VMs use `--eviction-policy Delete`, NIC and OS disk have `--delete-option Delete`. SSH keys generated.

#### 5.6.2 cloud-init via tempfile + `@path`

Render the cloud-init YAML once per provider instance, write it to a `0600` tempfile under `/tmp/rapid-evidence-cloud-init-*.yml`, and pass `--custom-data @<path>` to `az vm create`. **Never** inline the multi-KB YAML as an argv string — Azure CLI quoting edge cases will silently corrupt large payloads. Register `atexit` cleanup.

The cloud-init payload must be **minimal** (no `package_update`, no `packages:` — Ubuntu 22.04 already ships python3):

```yaml
#cloud-config
write_files:
  - path: /opt/rapid-evidence/eviction_watcher.py
    permissions: '0755'
    content: |
      # polls IMDS http://169.254.169.254/metadata/scheduledevents every 5s
      # writes to /var/log/rapid-evidence/eviction.json on Preempt/Terminate
  - path: /opt/rapid-evidence/outbound_probe.py
    permissions: '0755'
    content: |
      # iterates AzureSpotVmConfig.probe_urls until one returns the IP
      # writes /var/log/rapid-evidence/outbound_ip.json
  - path: /etc/systemd/system/rapid-evidence-eviction.service
    permissions: '0644'
    content: |
      [Unit] ... [Service] ExecStart=/usr/bin/python3 /opt/rapid-evidence/eviction_watcher.py ...
runcmd:
  - mkdir -p /var/log/rapid-evidence
  - /opt/rapid-evidence/outbound_probe.py || true
  - systemctl daemon-reload
  - systemctl enable --now rapid-evidence-eviction.service
```

The 5-second IMDS poll interval is critical: Spot’s preempt notice is ~30s, so a 10s poll wastes margin.

#### 5.6.3 SKU + Zone fallback (`_try_create_one`)

- Build `_size_rotation = (vm_size, *vm_size_fallbacks)` and `_zone_rotation = availability_zones or (None,)`.
- For each logical node attempt, **snapshot the shared `_rotation_index` under `_state_lock` and advance it by `attempts` (size×zone) up front** so parallel creators don’t collide on the same starting combo. True it up to `(start + attempt + 1) % len` after the first success.
- Use a **distinct physical VM name per attempt** (`{base_name}-a{counter:03d}`); the logical `node_id` is stable. This avoids the “first attempt left a partial NIC, second attempt fails with `ResourceAlreadyExists`” trap.
- An error is a capacity error iff it contains any of: `SkuNotAvailable`, `AllocationFailed`, `ZonalAllocationFailed`, `OverconstrainedAllocationRequest`, `OutOfCapacity`, `SpotMaxPriceTooLow`. Only capacity errors tr# Prompt: Build `rapid_evidence` — a policy-governed burst evidence collection toolkit with Azure Spot VM warm pool

You are tasked with implementing a Python package called `rapid_evidence`. It is **not** a general scraper, **not** a rate-limit evasion tool, and **not** a generic worker framework. Read every section before writing code.

---

## 1. Mission

Provide a **policy-governed**, **auditable**, **bounded** toolkit that:

1. Fetches evidence (papers, public-health records, API documents) from external HTTP archives **only when a per-source policy explicitly permits it**.
2. Runs work inside a **warm pool of Azure Spot VMs** so each worker gets its own outbound IP — useful for sources that legitimately require one-real-IP-per-worker (rate-limit fairness, attribution, audit).
3. Treats **cloud cost, Spot eviction, and data loss as first-class concerns**, not afterthoughts.
4. Stays **operable on a single workstation with Azure CLI** — no managed control plane, no Kubernetes, no asyncio infection.

---

## 2. Non-Goals (do not build these)

- ❌ No anti-bot evasion, no fingerprint spoofing, no residential proxy integration.
- ❌ No managed services (no AKS, no ACI, no Functions). One pluggable provider for local execution + one for raw Azure Spot VMs via `az` CLI subprocess.
- ❌ No persistent database. The audit ledger is append-only JSONL; the warm pool state is in-memory + reattached via VM tags on restart.
- ❌ No asyncio. Use `concurrent.futures.ThreadPoolExecutor` for parallelism. The toolkit is synchronous and embeddable.
- ❌ No hidden ambient credentials. Authentication is whatever `az` is already logged in as.
- ❌ No “smart” auto-retry that hides quota / capacity / policy errors. Surface them, do not paper over them.

---

## 3. Package Layout

```
rapid_evidence/
├── core/         # ids, time, errors, FetchRequest/Result, SourcePolicy, SurgeLimits, WorkerLease/Spec
├── policy/       # PolicyStore, default_policy_store(), validate_request()
├── queue/        # MemoryRequestQueue with max_queued + dedupe + requeue_front()
├── sources/      # GenericHttpSource (bounded body, retry-after parsing, GuardedHTTPTransport) + url_guard (DNS-resolving SSRF guard)
├── providers/    # LocalWorkerProvider (in-process). Worker provider Protocol lives in base.py
├── orchestrator/ # SurgeOrchestrator: bounded fan-out, budget cap, runtime cap
├── storage/      # FileSystemResultSink (0700 dir, 0600 files, fsync)
├── audit/        # JsonlAuditLedger (append-only, fsync, 0600)
├── spot/         # Spot VM warm-pool (models, scheduler, provider Protocol, in-memory fake, Azure CLI provider, sizing)
└── cli.py        # rapidfetch: run-local | spot-plan | spot-quota
```

Tests live in `tests/`. Benchmarks live in `benchmarks/` and are **opt-in only** (never run from default CI).

---

## 4. Hard Architectural Rules

### 4.1 Policy gate — no policy, no work

- `PolicyStore.require(source)` raises if no `SourcePolicy` is registered.
- `SourcePolicy` defines: `min_delay_seconds`, `max_concurrency`, `max_batch_size`, `max_workers`, `required_headers`, `allowed_methods`, `max_attempts`, `retry_after_seconds`.
- Every `FetchRequest` is validated against the source policy before being enqueued.
- The CLI `run-local` and any orchestrator call refuses to schedule if `args.batch_size > policy.max_batch_size`.

### 4.2 Bounded everything

- `MemoryRequestQueue(max_queued=N)` rejects with `QueueCapacityError` past the cap.
- `GenericHttpSource(max_body_bytes=N)` uses `httpx.stream()` + `iter_bytes()` and truncates past the cap.
- `SurgeOrchestrator` has hard `max_workers`, `max_runtime_seconds`, `max_budget_usd`.

### 4.3 SSRF defense in depth

- Implement `validate_public_http_url(url)` that:
  - Resolves the hostname via DNS.
  - Rejects loopback, link-local, private, multicast, unspecified, reserved, broadcast, and IPv6 ULA addresses.
  - Allows IP literals only after the same checks.
- Install a `GuardedHTTPTransport` wrapper so **every redirect target** is re-validated at dispatch time (close the TOCTOU gap).
- DNS validation must happen at dispatch, not just at enqueue.

### 4.4 Storage / audit hygiene

- Result sink directories `0o700`, files `0o600`, `fsync` after write.
- `JsonlAuditLedger.record(event_type, payload)` is append-only (`O_WRONLY | O_CREAT | O_APPEND`), `fsync`’d, thread-locked.
- The audit ledger is *the* observability surface — there is no separate metrics system.

### 4.5 Source name normalization

- All source names are lowercased + stripped at the model boundary. The queue, policy store, and worker spec all use the normalized form.

### 4.6 Worker env var validation

- `WorkerSpec(env={...})` validates each key as `^[A-Z_][A-Z0-9_]*$`.

### 4.7 Numeric input validation in `__post_init__`

- Every dataclass with numeric fields (timeouts, retry budgets, batch sizes, pool sizes, idle thresholds, IP share thresholds) validates the value in `__post_init__` and raises `ValueError` with a precise message.

---

## 5. The Spot VM Warm Pool — the heart of the system

### 5.1 Why a warm pool

For sources that legitimately require one real outbound IP per worker (rate-limit fairness, attribution), you need actual VMs. Cold-creating a VM takes ~60–90s per `az vm create`. To stay responsive, keep a configurable number of nodes pre-warmed and report exactly what is available right now without blocking on cold provisioning.

### 5.2 Models

```python
class SpotNodeState(StrEnum):
    PROVISIONING, READY, BUSY, DRAINING, TERMINATING, TERMINATED, FAILED, EVICTED

@dataclass(frozen=True)
class SpotPoolConfig:
    min_ready: int = 3
    max_nodes: int = 20
    per_node_concurrency: int = 1
    scale_up_batch: int = 5
    scale_down_batch: int = 5
    ready_timeout_seconds: int = 300
    cleanup_retries: int = 3
    idle_timeout_seconds: int = 600
    idle_floor: int | None = None        # None → fall back to min_ready
    max_same_subnet_share: float = 0.5   # alert when >50% of nodes share a /24
    # __post_init__ validates every field

@dataclass(frozen=True)
class SpotNode:
    node_id: str        # logical, stable across SKU/zone retries
    name: str           # physical Azure VM name (unique per attempt)
    state: SpotNodeState
    public_ip: str | None
    outbound_ip: str | None
    inflight: int = 0
    vm_size: str | None = None
    zone: str | None = None
    metadata: dict = field(default_factory=dict)
    error: str | None = None
    # `active` excludes TERMINATED/FAILED/EVICTED
    # `ready` requires state==READY AND inflight==0

@dataclass(frozen=True) class SpotPoolStatus     # nodes + capacity_plan + ip_distribution
@dataclass(frozen=True) class SpotCapacityPlan   # immediate_tasks, queued_tasks, overflow_tasks, target_nodes, scale_up_nodes, scale_down_nodes, estimated_new_ready_seconds
@dataclass(frozen=True) class SpotReservation    # node_ids, assignments: dict[node_id, tuple[task_id, ...]], unassigned_task_ids
@dataclass(frozen=True) class EvictionEvent      # node_id, public_ip, reason, requeue_task_ids
@dataclass(frozen=True) class QuotaSnapshot      # used/limit pairs + spot_quota_observed + public_ip_quota_observed + is_sufficient
@dataclass(frozen=True) class IpDistribution     # total_with_ip, unique_subnets, largest_subnet_share, violates_max_share
@dataclass(frozen=True) class CleanupReport
```

### 5.3 Provider protocol

```python
class SpotVmProvider(Protocol):
    provider_name: str
    def create_nodes(self, count: int, config: SpotPoolConfig) -> tuple[SpotNode, ...]: ...
    def refresh_nodes(self) -> tuple[SpotNode, ...]: ...
    def terminate_nodes(self, node_ids: tuple[str, ...]) -> tuple[str, ...]: ...

# Optional extension a real provider should implement:
class SpotVmDiscoveryProvider(Protocol):
    def discover_existing_nodes(self) -> tuple[SpotNode, ...]: ...
    def check_quota(self, requested_nodes: int, config: SpotPoolConfig) -> QuotaSnapshot: ...

class SpotAuditSink(Protocol):
    def record(self, event_type: str, payload: dict) -> None: ...
```

### 5.4 Scheduler invariants

Implement `SpotVmScheduler(provider, config, audit_sink=None, now=...)` with these methods:

- `initialize()` → reattach via `discover_existing_nodes()` if the provider supports it, then `ensure_min_ready()`.
- `ensure_min_ready()` → **must auto-terminate FAILED nodes** (`_terminate_failed_from(nodes)`) so cost does not leak. Replenish until ready ≥ `min_ready`.
- `status(requested_tasks=0)` → returns a fast, non-blocking `SpotPoolStatus`. Capacity plan reports `immediate_tasks` based on **currently ready** nodes, never on “after we cold-start more.”
- `reserve(requested_tasks, task_ids=None)` → assigns only ready nodes; records task↔node bindings; returns `SpotReservation` with `assignments` and `unassigned_task_ids`. Reject with `ValueError` if `len(task_ids) != requested_tasks`.
- `release(node_ids)` → returns nodes to ready, drops assignments, audits.
- `detect_evictions(previous_nodes=None)` → emits `EvictionEvent`s for nodes that disappeared; the events carry the `requeue_task_ids` the caller must re-enqueue.
- `apply_idle_timeout()` → if no `BUSY` nodes and `idle_timeout_seconds` elapsed since the last `reserve()`, scale ready down to `effective_idle_floor`.
- `cleanup_all()` → retried termination of all active nodes.
- `evicted_events()` / `drain_evicted_events()` → read-only view + drain. The internal history list is bounded by a constant (e.g. 1024).

### 5.5 Critical scheduler rules (from hardening)

1. **No silent task drops.** `_refresh_overlay()` must detect assignments whose node disappeared and surface them as implicit `EvictionEvent`s. A caller that never calls `detect_evictions()` still recovers tasks via `drain_evicted_events()`.
2. **Single refresh per iteration.** Do not call `provider.refresh_nodes()` twice in the same `ensure_min_ready()` loop iteration. Pass the node list to `_terminate_failed_from(nodes)`.
3. **FAILED nodes are real money.** Auto-terminate them on every `ensure_min_ready()` pass.
4. **Eviction history is bounded.** `_evicted` must never grow without bound — cap at a constant (`_EVICTED_HISTORY_MAX`) and expose `drain_evicted_events()` for caller-side ack.
5. **Audit failures must not break scheduling.** Wrap the sink call in `try/except` and swallow.
6. **All state mutation happens under `_lock` (`RLock`).** No exception.

### 5.6 Azure CLI provider — what must hold

`AzureSpotVmConfig` knobs (defaults shown):

```python
location="koreacentral"
vm_size="Standard_D2as_v5"
vm_size_fallbacks=()                       # rotated automatically on capacity errors
availability_zones=()                      # optional ("1","2","3")
image="Ubuntu2204"
nsg_name="rapid-evidence-egress-only"
address_prefix="10.42.0.0/16"
subnet_prefix="10.42.0.0/24"
max_price_usd=-1.0                         # -1 means "pay market"
probe_urls=("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")
vcpus_per_vm=2
spot_quota_name="standardDASv5Family"
create_concurrency=10
probe_concurrency=10
cloud_init_enabled=True
```

#### 5.6.1 Infrastructure (idempotent)

`_ensure_infrastructure()` creates:

- Resource group at `location`.
- NSG with a single rule: deny-all-inbound (priority 4000, `*` everything). All `try/except` so re-runs against an existing RG do not crash.
- VNet + subnet, then attaches the NSG to the subnet.

Public IPs are Standard SKU, Spot VMs use `--eviction-policy Delete`, NIC and OS disk have `--delete-option Delete`. SSH keys generated.

#### 5.6.2 cloud-init via tempfile + `@path`

Render the cloud-init YAML once per provider instance, write it to a `0600` tempfile under `/tmp/rapid-evidence-cloud-init-*.yml`, and pass `--custom-data @<path>` to `az vm create`. **Never** inline the multi-KB YAML as an argv string — Azure CLI quoting edge cases will silently corrupt large payloads. Register `atexit` cleanup.

The cloud-init payload must be **minimal** (no `package_update`, no `packages:` — Ubuntu 22.04 already ships python3):

```yaml
#cloud-config
write_files:
  - path: /opt/rapid-evidence/eviction_watcher.py
    permissions: '0755'
    content: |
      # polls IMDS http://169.254.169.254/metadata/scheduledevents every 5s
      # writes to /var/log/rapid-evidence/eviction.json on Preempt/Terminate
  - path: /opt/rapid-evidence/outbound_probe.py
    permissions: '0755'
    content: |
      # iterates AzureSpotVmConfig.probe_urls until one returns the IP
      # writes /var/log/rapid-evidence/outbound_ip.json
  - path: /etc/systemd/system/rapid-evidence-eviction.service
    permissions: '0644'
    content: |
      [Unit] ... [Service] ExecStart=/usr/bin/python3 /opt/rapid-evidence/eviction_watcher.py ...
runcmd:
  - mkdir -p /var/log/rapid-evidence
  - /opt/rapid-evidence/outbound_probe.py || true
  - systemctl daemon-reload
  - systemctl enable --now rapid-evidence-eviction.service
```

The 5-second IMDS poll interval is critical: Spot’s preempt notice is ~30s, so a 10s poll wastes margin.

#### 5.6.3 SKU + Zone fallback (`_try_create_one`)

- Build `_size_rotation = (vm_size, *vm_size_fallbacks)` and `_zone_rotation = availability_zones or (None,)`.
- For each logical node attempt, **snapshot the shared `_rotation_index` under `_state_lock` and advance it by `attempts` (size×zone) up front** so parallel creators don’t collide on the same starting combo. True it up to `(start + attempt + 1) % len` after the first success.
- Use a **distinct physical VM name per attempt** (`{base_name}-a{counter:03d}`); the logical `node_id` is stable. This avoids the “first attempt left a partial NIC, second attempt fails with `ResourceAlreadyExists`” trap.
- An error is a capacity error iff it contains any of: `SkuNotAvailable`, `AllocationFailed`, `ZonalAllocationFailed`, `OverconstrainedAllocationRequest`, `OutOfCapacity`, `SpotMaxPriceTooLow`. Only capacity errors trigger fallback rotation; non-capacity failures are surfaced immediately so they are not silently retried.
- The provider must preserve the logical node identity across retries, record the chosen size/zone on success, and keep the real Azure error text in node metadata for later analysis.
- A successful first attempt should update the rotation state so later parallel creators do not start from the same exhausted combination, while a failed attempt leaves the node in a failed/terminated state instead of hiding the partial resource leak.
- Refresh and teardown paths must reconcile VM state, update public/outbound IP metadata, and terminate failed or drained nodes with retries so warm-pool drift does not accumulate cost.

### 6. Runtime modes, aggregation, and interactive UI design

The toolkit must support two operating modes that share the same core scheduler and policy layer:

1. **CLI mode**: `rapidfetch` runs directly from the command line for local execution, manual batch runs, and debugging. The CLI uses `SourcePolicy` validation, `MemoryRequestQueue`, `LocalWorkerProvider`, `SurgeOrchestrator`, `FileSystemResultSink`, and `JsonlAuditLedger` without any web layer.
2. **API + UI mode**: a lightweight FastAPI service accepts URL lists, normalizes them, dispatches them through the same scheduler, then returns a gathered response. The API must not invent a separate execution model; it should orchestrate the same queue, provider, sink, and audit primitives used by the CLI.

The API design should therefore be structured as:

- `POST /run` or equivalent endpoint receives a payload containing `urls`, `min_vm`, `max_vm`, optional `source`, `batch_size`, and runtime controls.
- The FastAPI handler performs lightweight validation, normalizes the source name, and forwards the request to a synchronous orchestration layer.
- Because the library is synchronous, the FastAPI service must invoke the orchestration inside a threadpool or an application-level executor so incoming HTTP requests do not block the event loop or rely on asyncio-based workers.
- The response should include the parsed URL summary, scheduling decisions, per-URL result status, aggregate counts, and the warm-pool snapshot used for the run.

The URL ingestion contract must be robust against pasted text formats:

- Accept multiline text, commas, tabs, semicolons, repeated whitespace, and mixed separators in one input.
- Split on a broad delimiter set, trim whitespace, drop blanks, reject malformed entries, and preserve input order for deterministic reporting.
- Deduplicate repeated URLs while keeping the first occurrence order, and surface duplicate count separately in the API response.
- Validate each URL with the public HTTP URL guard before enqueueing; invalid entries must be reported in the response instead of silently dropped.
- The parser must be shared between CLI parsing, API ingestion, and the SPA so behavior stays identical across interfaces.

The warm-pool controller must treat `min_vm` and `max_vm` as live operational bounds:

- `min_vm` is the baseline floor that should remain warm when there is no active demand, subject to idle timeout and failed-node cleanup.
- `max_vm` is the hard upper bound that the scheduler may not exceed during provisioning.
- When the incoming URL backlog grows, the scheduler should scale up toward `min_vm` immediately for readiness and then further toward the current demand up to `max_vm` without blocking on cold-start completion.
- When workload drains, the scheduler should age idle nodes using `idle_timeout_seconds`, move nodes into `DRAINING`/`TERMINATING`, and reduce the ready pool back toward `min_vm`.
- The API response must expose the executed scaling decision as a plan: current ready, busy, provisioning, terminating, idle, and overflow counts.

The SPA should be a simple browser-deliverable interface used for quick validation and manual runs:

- A textarea for pasting URL lists with mixed delimiters.
- Controls for `min_vm`, `max_vm`, optional `batch_size`, optional `source`, and a run button.
- Real-time parsing preview showing cleaned URLs, duplicates removed, invalid entries, and estimated shard count.
- A status panel that visualizes the warm-pool states (`idle`, `running`, `provisioning`, `terminating`) as color-coded counters, progress bars, or stacked cards.
- A results area showing each URL result, success/error status, latency, and any policy or parsing warnings.
- The SPA should call the same backend contract as the CLI/API so that manual testing exercises the real ingestion and scheduling path rather than a mock-only flow.

The design must therefore preserve one execution contract across all surfaces:

- parser logic is shared,
- scheduling and warm-pool control are shared,
- result aggregation is shared,
- the UI only changes presentation and input convenience.

