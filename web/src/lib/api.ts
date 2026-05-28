/**
 * Typed API client for the rapid-evidence FastAPI backend.
 * All fetches go through `apiFetch` so 4xx/5xx surface as thrown errors.
 */

export interface PoolCounters {
  ready: number;
  busy: number;
  provisioning: number;
  terminating: number;
  evicted: number;
  failed: number;
  terminated: number;
  draining: number;
}

export interface PoolConfig {
  min_ready: number;
  max_nodes: number;
  per_node_concurrency: number;
  idle_timeout_seconds: number;
}

export interface PoolMetricsSnapshot {
  heartbeat_count: number;
  heartbeat_failures: number;
  last_heartbeat_at: string | null;
  reconcile_count: number;
  reconcile_failures: number;
  last_reconcile_at: string | null;
  evictions_total: number;
  failures_total: number;
  nodes_created_total: number;
  nodes_replaced_total: number;
  nodes_terminated_total: number;
  scale_up_total: number;
  scale_down_total: number;
}

export interface PoolBlock {
  running: boolean;
  provider?: string;
  config?: PoolConfig;
  counters?: Partial<PoolCounters>;
  metrics?: Partial<PoolMetricsSnapshot>;
  nodes?: PoolNodeSnapshot[];
  recent_evictions?: RecentEviction[];
}

export interface PoolNodeSnapshot {
  node_id: string;
  name: string;
  state: string;
  public_ip: string | null;
  outbound_ip: string | null;
  inflight: number;
  vm_size: string | null;
  zone: string | null;
  error: string | null;
}

export interface RecentEviction {
  node_id: string;
  public_ip: string | null;
  reason: string;
  requeue_task_ids: string[];
}

export interface ScaleTarget {
  target_nodes: number;
  scale_up_nodes: number;
  scale_down_nodes: number;
  immediate_tasks: number;
  queued_tasks: number;
  overflow_tasks: number;
}

export interface MetricSample {
  timestamp: string;
  backlog: number;
  throughput_per_second: number;
  active_vms: number;
  ready_vms: number;
  running_vms: number;
  provisioning_vms: number;
  draining_vms: number;
  active_batches: number;
}

export interface DashboardSummary {
  backlog: number;
  throughput_per_second: number;
  drain_eta_seconds: number | null;
  active_batches: number;
  pool: PoolBlock;
  scale_target: ScaleTarget | null;
  latest_sample: MetricSample | null;
  sample_interval_seconds: number | null;
}

export type BatchStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "cancelled"
  | "failed";

export interface BatchProgress {
  batch_id: string;
  source: string;
  status: BatchStatus;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  percent: number;
  workers_active: number;
  workers_target: number;
  throughput_per_second: number;
  eta_seconds: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface MetricsTimeseries {
  window_seconds: number | null;
  sample_interval_seconds: number;
  retention_seconds: number;
  samples: MetricSample[];
}

// ----- scaffold types (events / scaling / quota / regions / batch timeline)
// Used by the new sidebar pages added in the scaffold session.
// Follow-up sessions extend these as the page bodies materialise.

export interface RuntimeEvent {
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ScalingTimeline {
  window_seconds: number;
  samples: MetricSample[];
  events: RuntimeEvent[];
}

export interface QuotaStatus {
  observed: boolean;
  used?: number;
  limit?: number;
  spot_quota_observed?: boolean;
  public_ip_quota_observed?: boolean;
  is_sufficient?: boolean;
  checked_at?: string | null;
  error?: string | null;
}

export interface RegionSummary {
  region: string | null;
  nodes: number;
  ready: number;
  busy: number;
  evictions_recent: number;
}

export interface BatchTimelineEvent {
  timestamp: string;
  event_type: string;
  payload: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let payload: unknown = undefined;
    let message = `${res.status} ${res.statusText}`;
    try {
      payload = await res.json();
      if (payload && typeof payload === "object" && "detail" in payload) {
        message = String((payload as { detail: unknown }).detail);
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => apiFetch<{ ok: boolean }>("/health"),
  dashboardSummary: () => apiFetch<DashboardSummary>("/dashboard/summary"),
  metricsTimeseries: (windowSeconds?: number) => {
    const qs =
      windowSeconds !== undefined
        ? `?window_seconds=${encodeURIComponent(String(windowSeconds))}`
        : "";
    return apiFetch<MetricsTimeseries>(`/metrics/timeseries${qs}`);
  },
  listBatches: () =>
    apiFetch<{ batches: BatchProgress[] }>("/batches"),
  createBatch: (body: {
    source: string;
    targets: string[];
    workers?: number;
    metadata?: Record<string, unknown>;
  }) =>
    apiFetch<BatchProgress>("/batches", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelBatch: (batchId: string) =>
    apiFetch<BatchProgress>(`/batches/${batchId}/cancel`, { method: "POST" }),
  poolScale: (requestedTasks: number) =>
    apiFetch<unknown>("/pool/scale", {
      method: "POST",
      body: JSON.stringify({ requested_tasks: requestedTasks }),
    }),
  listEvents: (opts: { since?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return apiFetch<{ events: RuntimeEvent[] }>(
      `/events${qs ? `?${qs}` : ""}`,
    );
  },
  scalingTimeline: (windowSeconds: number) =>
    apiFetch<ScalingTimeline>(
      `/scaling/timeline?window_seconds=${encodeURIComponent(String(windowSeconds))}`,
    ),
  quotaStatus: () => apiFetch<QuotaStatus>("/quota/status"),
  regionsStatus: () => apiFetch<{ regions: RegionSummary[] }>("/regions/status"),
  batchTimeline: (batchId: string) =>
    apiFetch<{ events: BatchTimelineEvent[] }>(
      `/batches/${encodeURIComponent(batchId)}/timeline`,
    ),
};
