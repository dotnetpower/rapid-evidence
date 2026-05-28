import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type BatchProgress } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  BatchFilterBar,
  type BatchFilter,
  type BatchSort,
} from "../components/batches/BatchFilterBar";
import { BatchListTable } from "../components/batches/BatchListTable";
import { BatchDetailDrawer } from "../components/batches/BatchDetailDrawer";

const ACTIVE_STATES = new Set(["queued", "running", "paused"]);
const TERMINAL_STATES = new Set(["done", "cancelled", "failed"]);

function applyFilter(rows: BatchProgress[], filter: BatchFilter): BatchProgress[] {
  if (filter === "all") return rows;
  const target = filter === "active" ? ACTIVE_STATES : TERMINAL_STATES;
  return rows.filter((r) => target.has(r.status));
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

export function BatchesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { batchId } = useParams<{ batchId?: string }>();
  const [filter, setFilter] = useState<BatchFilter>("all");
  const [sort, setSort] = useState<BatchSort>("newest");

  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.listBatches().then((r) => r.batches),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const rows = batches.data ?? [];
  const visible = useMemo(
    () => applySort(applyFilter(rows, filter), sort),
    [rows, filter, sort],
  );

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
        </div>
      </div>

      <BatchFilterBar
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        count={visible.length}
      />

      <BatchListTable
        rows={visible}
        selectedId={batchId ?? null}
        onSelect={(id) => navigate(`/batches/${id}`)}
      />

      {batchId && (
        <BatchDetailDrawer
          batchId={batchId}
          onClose={() => navigate("/batches")}
        />
      )}
    </div>
  );
}
