import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type BatchProgress } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useToast } from "../lib/useToast";
import { useCtrlOrCmdHotkey } from "../lib/useHotkey";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import {
  BatchFilterBar,
  type BatchFilter,
  type BatchFilterCounts,
  type BatchSort,
} from "../components/batches/BatchFilterBar";
import { BatchListTable } from "../components/batches/BatchListTable";
import { BatchDetailDrawer } from "../components/batches/BatchDetailDrawer";
import { NewBatchDialog } from "../components/NewBatchDialog";

const ACTIVE_STATES = new Set(["queued", "running", "paused"]);
const TERMINAL_STATES = new Set(["done", "cancelled", "failed"]);

/**
 * Fused filter + text-query in a single pass. The previous version walked
 * `rows` three times (filter, query, sort copy); for 1k batches that's
 * ~3k iterations per keystroke. Fusing the two filters into one loop and
 * sorting only the surviving rows cuts that to ~k + sort(filtered.length).
 */
function applyFilterAndQuery(
  rows: BatchProgress[],
  filter: BatchFilter,
  q: string,
): BatchProgress[] {
  const needle = q.trim().toLowerCase();
  const wantsFilter = filter !== "all";
  const target = filter === "active" ? ACTIVE_STATES : TERMINAL_STATES;
  if (!wantsFilter && !needle) return rows;
  const out: BatchProgress[] = [];
  for (const r of rows) {
    if (wantsFilter && !target.has(r.status)) continue;
    if (needle) {
      if (
        !r.batch_id.toLowerCase().includes(needle) &&
        !r.source.toLowerCase().includes(needle) &&
        !r.status.toLowerCase().includes(needle)
      ) {
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

function applySort(rows: BatchProgress[], sort: BatchSort): BatchProgress[] {
  const copy = [...rows];
  if (sort === "rate") {
    copy.sort((a, b) => b.throughput_per_second - a.throughput_per_second);
  } else if (sort === "evictions") {
    copy.sort((a, b) => {
      const ea = Number((a.metadata as Record<string, unknown>)?.evictions_observed ?? 0);
      const eb = Number((b.metadata as Record<string, unknown>)?.evictions_observed ?? 0);
      return eb - ea;
    });
  } else {
    copy.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  return copy;
}

function isValidFilter(v: string | null): v is BatchFilter {
  return v === "all" || v === "active" || v === "terminal";
}

export function BatchesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { batchId } = useParams<{ batchId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-persistent filter (`?filter=active|terminal|all`).
  // Falls back to "all" when the param is missing or invalid.
  const urlFilter = searchParams.get("filter");
  const filter: BatchFilter = isValidFilter(urlFilter) ? urlFilter : "all";
  const setFilter = (next: BatchFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("filter");
    else params.set("filter", next);
    setSearchParams(params, { replace: true });
  };

  const [sort, setSort] = useState<BatchSort>("newest");
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.listBatches().then((r) => r.batches),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const rows = batches.data ?? [];

  // Bounded by `rows.length`; recomputed only when rows change.
  const counts: BatchFilterCounts = useMemo(() => {
    let active = 0;
    let terminal = 0;
    for (const r of rows) {
      if (ACTIVE_STATES.has(r.status)) active += 1;
      else if (TERMINAL_STATES.has(r.status)) terminal += 1;
    }
    return { all: rows.length, active, terminal };
  }, [rows]);

  const visible = useMemo(
    () => applySort(applyFilterAndQuery(rows, filter, query), sort),
    [rows, filter, query, sort],
  );

  // Stable callback so the memoised `BatchListRow` doesn't reconcile
  // every row on every parent render (2 s poll cadence).
  const handleSelect = useCallback(
    (id: string) => navigate(`/batches/${id}`),
    [navigate],
  );

  // Document title: active count → shown in background tabs.
  useDocumentTitle(t("batches.page.title"), counts.active > 0 ? counts.active : null);

  // Ctrl+N opens the New Batch dialog (shared hook; mirrors Throughput page).
  useCtrlOrCmdHotkey({ key: "n", onTrigger: () => setDialogOpen(true) });

  function exportCsv() {
    if (visible.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    const headers = [
      "batch_id",
      "source",
      "status",
      "total",
      "percent",
      "throughput_per_second",
      "eta_seconds",
      "workers_active",
      "workers_target",
      "evictions_observed",
      "node_count",
      "created_at",
    ];
    const data = visible.map((b) => {
      const evObs = Number((b.metadata as Record<string, unknown>)?.evictions_observed ?? 0);
      const nodes = Object.keys((b.metadata?.node_counts ?? {}) as Record<string, number>).length;
      return [
        b.batch_id,
        b.source,
        b.status,
        b.total,
        Number(b.percent.toFixed(2)),
        Number(b.throughput_per_second.toFixed(3)),
        b.eta_seconds ?? "",
        b.workers_active,
        b.workers_target,
        evObs,
        nodes,
        b.created_at,
      ];
    });
    downloadCsv(`batches-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{t("batches.page.title")}</h1>
          <div className="sub">{t("batches.page.sub")}</div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => batches.refetch()}
            disabled={batches.isFetching}
          >
            {t("batches.page.refresh")}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => setDialogOpen(true)}
          >
            ＋ {t("page.newBatch")}
          </button>
        </div>
      </div>

      <BatchFilterBar
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        count={visible.length}
        disabled={rows.length === 0}
        counts={counts}
        query={query}
        onQueryChange={setQuery}
        onExport={exportCsv}
        exportDisabled={visible.length === 0}
      />

      <BatchListTable
        rows={visible}
        selectedId={batchId ?? null}
        onSelect={handleSelect}
      />

      {batchId && (
        <BatchDetailDrawer
          batchId={batchId}
          onClose={() => navigate("/batches")}
        />
      )}

      <NewBatchDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

