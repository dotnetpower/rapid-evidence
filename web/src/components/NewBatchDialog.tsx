import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";

interface NewBatchDialogProps {
  open: boolean;
  onClose: () => void;
}

const PLACEHOLDER = `https://example.com/a
https://example.com/b
https://example.com/c`;

function splitTargets(text: string): string[] {
  return text
    .split(/[\n,;\t]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function NewBatchDialog({ open, onClose }: NewBatchDialogProps) {
  const [source, setSource] = useState("generic-http");
  const [targetsText, setTargetsText] = useState("");
  const [workers, setWorkers] = useState("4");
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createBatch({
        source,
        targets: splitTargets(targetsText),
        workers: Math.max(1, Number(workers) || 1),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] });
      setTargetsText("");
      onClose();
    },
  });

  if (!open) return null;

  const error = create.error instanceof ApiError ? create.error.message : null;
  const targetCount = splitTargets(targetsText).length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="새 배치 등록">
        <header>
          <h2>새 배치 등록</h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
        </header>
        <div className="body">
          {error && <div className="error-banner">{error}</div>}
          <div className="field">
            <label htmlFor="source">source</label>
            <input
              id="source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
            <span className="hint">정책에 등록된 소스 이름 (기본 generic-http)</span>
          </div>
          <div className="field">
            <label htmlFor="targets">targets · {targetCount}개</label>
            <textarea
              id="targets"
              placeholder={PLACEHOLDER}
              value={targetsText}
              onChange={(e) => setTargetsText(e.target.value)}
            />
            <span className="hint">개행, 쉼표, 세미콜론으로 구분</span>
          </div>
          <div className="field">
            <label htmlFor="workers">workers</label>
            <input
              id="workers"
              type="number"
              min={1}
              value={workers}
              onChange={(e) => setWorkers(e.target.value)}
            />
          </div>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>취소</button>
          <button
            className="btn primary"
            disabled={targetCount === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "등록 중…" : `＋ 등록 (${targetCount})`}
          </button>
        </footer>
      </div>
    </div>
  );
}
