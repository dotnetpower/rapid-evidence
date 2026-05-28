import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BatchProgress, type BatchStatus } from "../lib/api";
import { formatDuration, formatNumber, formatPercent, formatRate } from "../lib/format";

const TERMINAL_STATES: BatchStatus[] = ["done", "cancelled", "failed"];

function meterColor(status: BatchStatus): string {
  switch (status) {
    case "paused": return "warn";
    case "queued": return "";
    case "done": return "ok";
    case "failed": return "warn";
    case "cancelled": return "";
    default: return "violet";
  }
}

export function BatchesTable() {
  const queryClient = useQueryClient();
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

  const rows: BatchProgress[] = batches.data ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="title">배치 큐 · {rows.length}개</span>
        <span className="meta">갱신 2초 · 정렬: 최근 생성</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          {batches.isLoading
            ? "로드 중…"
            : "등록된 배치가 없습니다. 우측 상단 “＋ 새 배치”로 추가하세요."}
        </div>
      ) : (
        <table className="batches">
          <thead>
            <tr>
              <th style={{ width: "28%" }}>배치</th>
              <th style={{ width: 80 }}>요청 수</th>
              <th>진행</th>
              <th style={{ width: 90 }}>처리율</th>
              <th style={{ width: 100 }}>ETA</th>
              <th style={{ width: 70 }}>workers</th>
              <th style={{ width: 90 }}>상태</th>
              <th style={{ width: 90, textAlign: "right" }}>조작</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.batch_id}>
                <td className="name id-cell">
                  <div className="id">{b.batch_id}</div>
                  <div className="src">{b.source}</div>
                </td>
                <td>{formatNumber(b.total)}</td>
                <td>
                  <div className="prog">
                    <div className={`meter ${meterColor(b.status)}`}>
                      <span style={{ width: `${b.percent}%` }} />
                    </div>
                    <span className="pct">{formatPercent(b.percent)}</span>
                  </div>
                </td>
                <td>{formatRate(b.throughput_per_second)}</td>
                <td>
                  {b.status === "done"
                    ? "완료"
                    : b.status === "cancelled"
                    ? "취소됨"
                    : b.status === "failed"
                    ? "실패"
                    : formatDuration(b.eta_seconds)}
                </td>
                <td>
                  {b.workers_active}/{b.workers_target}
                </td>
                <td>
                  <span className={`tag ${b.status}`}>{b.status}</span>
                </td>
                <td className="row-act">
                  <button
                    className="icon-btn"
                    onClick={() => cancelMut.mutate(b.batch_id)}
                    disabled={TERMINAL_STATES.includes(b.status) || cancelMut.isPending}
                    title="취소"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
