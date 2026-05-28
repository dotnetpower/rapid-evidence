import type { BackgroundJob } from "../../lib/api";
import type { RegionProbe } from "./RegionQuotaTable";

export interface ProbeBundle {
  byRegion: Record<string, RegionProbe>;
  probes: RegionProbe[];
  totalLimit: number;
  totalUsed: number;
  totalHeadroom: number;
  observedCount: number;
  totalCount: number;
  lastScanAt: string | null;
  spotQuotaName: string | null;
}

function emptyBundle(): ProbeBundle {
  return {
    byRegion: {},
    probes: [],
    totalLimit: 0,
    totalUsed: 0,
    totalHeadroom: 0,
    observedCount: 0,
    totalCount: 0,
    lastScanAt: null,
    spotQuotaName: null,
  };
}

export function extractProbeBundle(jobs: BackgroundJob[]): ProbeBundle {
  // Pick the most recent succeeded `azure-region-quota-scan` job and
  // unpack its `MultiRegionQuotaReport` payload. The job result is
  // shaped by `MultiRegionQuotaReport.to_dict()`.
  const sorted = [...jobs].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  const latest = sorted.find(
    (j) => j.name === "azure-region-quota-scan" && j.status === "succeeded" && j.result,
  );
  if (!latest || !latest.result) return emptyBundle();
  const result = latest.result as { regions?: unknown; totals?: unknown };
  const raw = Array.isArray(result.regions) ? result.regions : [];
  const probes: RegionProbe[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const region = typeof rec.region === "string" ? rec.region : null;
    if (!region) continue;
    probes.push({
      region,
      used: typeof rec.used === "number" ? rec.used : null,
      limit: typeof rec.limit === "number" ? rec.limit : null,
      headroom: typeof rec.headroom === "number" ? rec.headroom : null,
      observed: rec.observed === true,
      error: typeof rec.error === "string" ? rec.error : null,
    });
  }
  const byRegion: Record<string, RegionProbe> = {};
  for (const p of probes) byRegion[p.region] = p;

  const totalsEnv = result.totals as Record<string, unknown> | undefined;
  let totalLimit = 0;
  let totalUsed = 0;
  let totalHeadroom = 0;
  if (totalsEnv && typeof totalsEnv === "object") {
    if (typeof totalsEnv.limit === "number") totalLimit = totalsEnv.limit;
    if (typeof totalsEnv.used === "number") totalUsed = totalsEnv.used;
    if (typeof totalsEnv.headroom === "number") totalHeadroom = totalsEnv.headroom;
  }
  if (totalLimit === 0 && totalUsed === 0 && totalHeadroom === 0) {
    for (const p of probes) {
      if (p.observed) {
        totalLimit += p.limit ?? 0;
        totalUsed += p.used ?? 0;
        totalHeadroom += p.headroom ?? 0;
      }
    }
  }

  const metadata = (latest.metadata ?? {}) as Record<string, unknown>;
  const spotQuotaName =
    typeof metadata.spot_quota_name === "string"
      ? metadata.spot_quota_name
      : null;

  return {
    byRegion,
    probes,
    totalLimit,
    totalUsed,
    totalHeadroom,
    observedCount: probes.filter((p) => p.observed).length,
    totalCount: probes.length,
    lastScanAt: latest.finished_at ?? latest.started_at ?? null,
    spotQuotaName,
  };
}
