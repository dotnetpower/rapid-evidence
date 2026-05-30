import { type BatchProgress } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { BatchListRow } from "./BatchListRow";

interface Props {
  rows: BatchProgress[];
  selectedId: string | null;
  onSelect: (batchId: string) => void;
}

export function BatchListTable({ rows, selectedId, onSelect }: Props) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="empty">{t("batches.list.empty")}</div>;
  }
  return (
    <section className="panel">
      <table className="batches">
        <thead>
          <tr>
            <th style={{ width: "26%" }}>{t("batches.list.col.batch")}</th>
            <th style={{ width: 110 }}>{t("batches.list.col.source")}</th>
            <th style={{ width: 90 }}>{t("batches.list.col.status")}</th>
            <th>{t("batches.list.col.progress")}</th>
            <th style={{ width: 90 }}>{t("batches.list.col.rate")}</th>
            <th style={{ width: 80 }}>{t("batches.list.col.workers")}</th>
            <th style={{ width: 70 }}>{t("batches.list.col.nodes")}</th>
            <th style={{ width: 80 }}>{t("batches.list.col.evictions")}</th>
            <th style={{ width: 110 }}>{t("batches.list.col.created")}</th>
          </tr>
        </thead>
        <tbody>
          {/* Each row is `React.memo`d \u2014 polling at 2 s no longer
              reconciles every row when only a couple changed. */}
          {rows.map((row) => (
            <BatchListRow
              key={row.batch_id}
              row={row}
              isSelected={selectedId === row.batch_id}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}
