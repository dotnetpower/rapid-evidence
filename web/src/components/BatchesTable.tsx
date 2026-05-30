import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BatchProgress } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useToast } from "../lib/useToast";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import { BatchesTableRow, isCancellableBatch } from "./BatchesTableRow";

export function BatchesTable() {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const batches = useQuery({
    queryKey: ["batches"],
    queryFn: () => api.listBatches().then((r) => r.batches),
    refetchInterval: 2000,
    staleTime: 1500,
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => api.cancelBatch(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["batches"] }),
  });

  const allRows: BatchProgress[] = batches.data ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (b) =>
        b.batch_id.toLowerCase().includes(q) ||
        b.source.toLowerCase().includes(q) ||
        b.status.toLowerCase().includes(q),
    );
  }, [allRows, search]);

  // Reconcile selected set against current rows (prune ids no longer present
  // and ids that are no longer cancellable). Bounded by `rows.length`.
  const visibleSelected = useMemo(() => {
    const present = new Set<string>();
    for (const r of rows) {
      if (selected.has(r.batch_id) && isCancellableBatch(r)) present.add(r.batch_id);
    }
    return present;
  }, [rows, selected]);

  const cancellableRows = useMemo(() => rows.filter(isCancellableBatch), [rows]);
  const allSelected =
    cancellableRows.length > 0 && cancellableRows.every((r) => visibleSelected.has(r.batch_id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const r of cancellableRows) next.delete(r.batch_id);
      } else {
        for (const r of cancellableRows) next.add(r.batch_id);
      }
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function bulkCancel() {
    const ids = Array.from(visibleSelected);
    if (ids.length === 0) return;
    let ok = 0;
    let failed = 0;
    // Sequential to respect server policy and surface per-id errors clearly.
    for (const id of ids) {
      try {
        await api.cancelBatch(id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    queryClient.invalidateQueries({ queryKey: ["batches"] });
    clearSelection();
    if (failed === 0) toast(t("toast.bulkCancelled", { n: ok }), "success");
    else toast(t("toast.bulkCancelFailed"), failed === ids.length ? "error" : "info");
  }

  function exportCsv() {
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
    ];
    const data = rows.map((b) => [
      b.batch_id,
      b.source,
      b.status,
      b.total,
      Number(b.percent.toFixed(2)),
      Number(b.throughput_per_second.toFixed(3)),
      b.eta_seconds ?? "",
      b.workers_active,
      b.workers_target,
    ]);
    if (data.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    downloadCsv(`batches-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">{t("batches.title", { n: rows.length })}</span>
        <span className="meta">{t("batches.meta")}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label className="toolbar-search" aria-label={t("common.search")}>
            <span aria-hidden>⌕</span>
            <input
              type="search"
              value={search}
              placeholder={t("batches.table.search.placeholder")}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                className="clear"
                onClick={() => setSearch("")}
                title={t("common.clear")}
                aria-label={t("common.clear")}
              >
                ×
              </button>
            )}
          </label>
          <button
            className="btn"
            onClick={exportCsv}
            disabled={rows.length === 0}
            title={t("common.exportCsv")}
          >
            ⇩ CSV
          </button>
        </div>
      </div>

      {visibleSelected.size > 0 && (
        <div
          className="bulk-bar"
          role="region"
          aria-label={t("batches.table.bulkBar.title", { n: visibleSelected.size })}
        >
          <span>{t("batches.table.bulkBar.title", { n: visibleSelected.size })}</span>
          <span className="grow" />
          <button className="btn" onClick={bulkCancel} disabled={cancelMut.isPending}>
            {t("batches.table.bulkBar.cancel")}
          </button>
          <button className="btn" onClick={clearSelection}>
            {t("batches.table.bulkBar.clear")}
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          {batches.isLoading
            ? t("batches.empty.loading")
            : search
            ? t("common.noResults")
            : t("batches.empty.none")}
        </div>
      ) : (
        <table className="batches">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label={t("common.selectAll")}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={cancellableRows.length === 0}
                />
              </th>
              <th style={{ width: "28%" }}>{t("batches.col.batch")}</th>
              <th style={{ width: 80 }}>{t("batches.col.requests")}</th>
              <th>{t("batches.col.progress")}</th>
              <th style={{ width: 90 }}>{t("batches.col.rate")}</th>
              <th style={{ width: 100 }}>{t("batches.col.eta")}</th>
              <th style={{ width: 70 }}>{t("batches.col.workers")}</th>
              <th style={{ width: 90 }}>{t("batches.col.status")}</th>
              <th style={{ width: 90, textAlign: "right" }}>{t("batches.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <BatchesTableRow
                key={b.batch_id}
                batch={b}
                checked={visibleSelected.has(b.batch_id)}
                cancellable={isCancellableBatch(b)}
                cancelPending={cancelMut.isPending}
                onToggle={toggleOne}
                onCancel={(id) => cancelMut.mutate(id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
