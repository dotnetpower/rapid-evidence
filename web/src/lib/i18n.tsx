import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "en" | "ko";

const STORAGE_KEY = "rapid-evidence:lang";

type Dict = Record<string, string>;

const en: Dict = {
  // titlebar / status
  "title.ops": "Operations",
  "title.crumb.throughput": "Throughput",
  "title.crumb.regions": "Regions",
  "title.crumb.batches": "Batches",
  "title.crumb.scaling": "Scaling Timeline",
  "title.crumb.quota": "Quota",
  "title.crumb.audit": "Audit",
  "title.crumb.unknown": "Unknown",
  "status.connected": "connected · /dashboard/summary",
  "status.connecting": "connecting…",
  "status.disconnected": "disconnected",
  "status.provider": "provider",
  // sidebar
  "nav.notImplemented": "not yet implemented",
  "nav.session": "Session",
  "nav.autorefresh": "Auto-refresh 2s",
  // statusbar
  "bar.pool": "pool",
  "bar.poolActive": "active",
  "bar.backlog": "backlog",
  "bar.drainEta": "drain ETA",
  "bar.lastSample": "last sample",
  // throughput page
  "page.throughput.title": "Throughput",
  "page.throughput.sub": "Backlog · pool scaling · request rate at a glance",
  "page.refresh": "Refresh",
  "page.newBatch": "New batch",
  "page.err.apiDown": "API unreachable — make sure the backend (uvicorn) is running.",
  "page.err.apiBoot": "Waiting for backend… (uvicorn :8800 is slow to respond or not up yet)",
  // KPIs
  "kpi.backlog.label": "backlog (pending requests)",
  "kpi.backlog.unit": "req",
  "kpi.backlog.activeBatches": "{n} active batches",
  "kpi.tp.label": "throughput (1 min)",
  "kpi.tp.unit": "req/s",
  "kpi.tp.activeSamples": "{n} active in latest sample",
  "kpi.drain.label": "drain ETA (current rate)",
  "kpi.drain.starved": "throughput 0 — workers starved",
  "kpi.drain.empty": "backlog empty",
  "kpi.drain.rate": "rate {rate}",
  "kpi.spot.label": "spot vm (active / target / max)",
  "kpi.spot.detail": "ready {ready} · running {running} · prov {prov}",
  "kpi.spot.autostartOff": "pool autostart disabled",
  // pool panel
  "pool.title": "Pool scaling progress",
  "pool.meta": "target {target} · current {active}",
  "pool.metaMax": " · max {max}",
  "pool.scaleProgress": "scale progress",
  "pool.scaleUpNodes": "scale-up nodes",
  "pool.overflowTasks": "overflow tasks",
  "pool.evictionsTotal": "evictions (total)",
  "pool.replaced": "replaced",
  "pool.nodesNone": "spot nodes",
  "pool.nodesList": "spot nodes · {n}",
  "pool.col.id": "id",
  "pool.col.state": "state",
  "pool.col.inflight": "inflight",
  "pool.col.outbound": "outbound",
  "pool.recentEvictions": "recent evictions · {n}",
  "pool.requeued": "requeued",
  // chart
  "chart.title": "Queue depth vs VM count vs throughput",
  "chart.legend.backlog": "queue depth (backlog)",
  "chart.legend.vms": "active VMs",
  "chart.legend.tp": "throughput req/s",
  "chart.collecting": "collecting samples…",
  "chart.notEnough": "not enough samples — retry in a few seconds.",
  // batches table
  "batches.title": "Batch queue · {n}",
  "batches.meta": "refresh 2s · sort: newest",
  "batches.empty.loading": "loading…",
  "batches.empty.none": "No batches. Use “+ New batch” in the top right.",
  "batches.col.batch": "batch",
  "batches.col.requests": "requests",
  "batches.col.progress": "progress",
  "batches.col.rate": "rate",
  "batches.col.eta": "ETA",
  "batches.col.workers": "workers",
  "batches.col.status": "status",
  "batches.col.actions": "actions",
  "batches.status.done": "done",
  "batches.status.cancelled": "cancelled",
  "batches.status.failed": "failed",
  "batches.cancel": "cancel",
  "batches.nodes": "{n} node",
  "batches.nodes_plural": "{n} nodes",
  "batches.evictTooltip": "spot eviction events touching {n} request(s)",
  // new batch dialog
  "dialog.title": "Register new batch",
  "dialog.close": "close",
  "dialog.source.hint": "source name registered in policy (default generic-http)",
  "dialog.targets.label": "targets · {n}",
  "dialog.targets.hint": "split by newline, comma or semicolon",
  "dialog.workers": "workers",
  "dialog.cancel": "Cancel",
  "dialog.submitting": "Registering…",
  "dialog.submit": "+ Register ({n})",
  // language
  "lang.toggle": "EN / 한",
  "lang.en": "EN",
  "lang.ko": "한",
  // batches page (scaffold — follow-up session fills body)
  "batches.page.title": "Batches",
  "batches.page.sub": "Per-batch progress, workers, and eviction history",
  "batches.filter.all": "All",
  "batches.filter.active": "Active",
  "batches.filter.terminal": "Terminal",
  "batches.drawer.title": "Batch detail",
  "batches.drawer.requests": "Requests",
  "batches.drawer.nodes": "Nodes",
  "batches.drawer.evictions": "Evictions",
  "batches.drawer.timeline": "Timeline",
  "batches.page.count": "{n} batches",
  "batches.page.refresh": "Refresh",
  "batches.sort.label": "Sort",
  "batches.sort.newest": "Newest first",
  "batches.sort.rate": "Throughput",
  "batches.sort.evictions": "Evictions",
  "batches.list.empty": "No batches match the current filter.",
  "batches.list.col.batch": "batch",
  "batches.list.col.source": "source",
  "batches.list.col.status": "status",
  "batches.list.col.progress": "progress",
  "batches.list.col.rate": "rate",
  "batches.list.col.workers": "workers",
  "batches.list.col.nodes": "nodes",
  "batches.list.col.evictions": "evictions",
  "batches.list.col.created": "created",
  "batches.drawer.close": "close",
  "batches.drawer.summary": "Summary",
  "batches.drawer.summary.total": "requests",
  "batches.drawer.summary.completed": "completed",
  "batches.drawer.summary.failed": "failed",
  "batches.drawer.summary.pending": "pending",
  "batches.drawer.summary.rate": "rate",
  "batches.drawer.summary.eta": "ETA",
  "batches.drawer.summary.workers": "workers",
  "batches.drawer.nodes.empty": "No per-node dispatch recorded yet.",
  "batches.drawer.nodes.col.node": "node",
  "batches.drawer.nodes.col.count": "requests",
  "batches.drawer.nodes.col.share": "share",
  "batches.drawer.evictions.observed": "{n} eviction events observed",
  "batches.drawer.evictions.empty": "No eviction events touched this batch.",
  "batches.drawer.evictions.requestIds": "Affected request IDs",
  "batches.drawer.timeline.empty": "No timeline events recorded yet.",
  "batches.drawer.timeline.loading": "loading timeline…",
  "batches.drawer.cancel": "Cancel batch",
  "batches.drawer.notFound": "Batch not found (it may have been pruned).",
  // audit page (scaffold)
  "audit.page.title": "Audit",
  "audit.page.sub": "Append-only ledger of pool and batch events",
  "audit.filter.all": "All events",
  "audit.filter.event": "Event type",
  "audit.empty": "No audit events yet",
  "audit.payload.show": "payload",
  "audit.payload.hide": "hide",
  // scaling timeline page (scaffold)
  "scaling.page.title": "Scaling Timeline",
  "scaling.page.sub": "Pool capacity vs queue depth over time, with scale events",
  "scaling.legend.ready": "ready",
  "scaling.legend.busy": "busy",
  "scaling.legend.prov": "provisioning",
  "scaling.legend.draining": "draining",
  "scaling.legend.event": "event",
  "scaling.chart.title": "Pool capacity (stacked) vs scale events",
  "scaling.chart.meta": "{samples} samples · {events} events",
  "scaling.markers.title": "Scale events",
  "scaling.markers.meta": "{n} events",
  "scaling.markers.empty": "No scale events in the selected window",
  "scaling.empty": "collecting samples…",
  // quota page (scaffold)
  "quota.page.title": "Quota",
  "quota.page.sub": "Observed Spot vCPU and public IP quota for this subscription",
  "quota.meter.label": "Spot vCPU usage",
  "quota.meter.sufficient": "sufficient",
  "quota.meter.insufficient": "insufficient",
  "quota.notObserved": "Quota not yet observed — provider has not reported usage.",
  "quota.checked": "checked",
  "quota.never": "never",
  "quota.error": "last error",
  "quota.spot_observed": "Spot quota observed",
  "quota.ip_observed": "Public IP quota observed",
  "quota.headroom": "headroom",
  "quota.refresh": "refresh now",
  // regions page (scaffold)
  "regions.page.title": "Regions",
  "regions.page.sub": "Spot node distribution across Azure regions",
  "regions.card.nodes": "nodes",
  "regions.card.ready": "ready",
  "regions.card.busy": "busy",
  "regions.card.evictions": "evictions",
  "regions.empty": "No regions reported yet",
  "regions.unknown": "(unknown)",
  "regions.nodes_detail": "Nodes in {region}",
  "regions.col.id": "id",
  "regions.col.state": "state",
  "regions.col.outbound": "outbound IP",
  "regions.click_hint": "click a card to see its nodes",
  // background jobs (used by Quota page panel)
  "jobs.panel.title": "Background jobs",
  "jobs.panel.empty": "No background jobs yet",
  "jobs.probe.title": "Scan all Azure regions",
  "jobs.probe.button": "scan now",
  "jobs.probe.running": "scanning…",
  "jobs.probe.hint": "Runs `az vm list-usage` against {count} regions in parallel. The result is shown in the jobs list below and updates the totals on this page.",
  "jobs.status.running": "running",
  "jobs.status.succeeded": "succeeded",
  "jobs.status.failed": "failed",
  "jobs.status.cancelled": "cancelled",
  "jobs.col.name": "name",
  "jobs.col.status": "status",
  "jobs.col.started": "started",
  "jobs.col.duration": "duration",
  "jobs.col.summary": "summary",
};

const ko: Dict = {
  "title.ops": "Operations",
  "title.crumb.throughput": "처리량",
  "title.crumb.regions": "리전",
  "title.crumb.batches": "배치",
  "title.crumb.scaling": "확장 타임라인",
  "title.crumb.quota": "쿼터",
  "title.crumb.audit": "감사",
  "title.crumb.unknown": "알 수 없음",
  "status.connected": "연결됨 · /dashboard/summary",
  "status.connecting": "연결 중…",
  "status.disconnected": "연결 끊김",
  "status.provider": "provider",
  "nav.notImplemented": "아직 구현되지 않음",
  "nav.session": "세션",
  "nav.autorefresh": "자동 새로고침 2초",
  "bar.pool": "풀",
  "bar.poolActive": "활성",
  "bar.backlog": "백로그",
  "bar.drainEta": "비우는 데",
  "bar.lastSample": "최근 샘플",
  "page.throughput.title": "처리량 (Throughput)",
  "page.throughput.sub": "백로그 · 풀 확장 속도 · 처리율을 한 화면에서 추적",
  "page.refresh": "새로고침",
  "page.newBatch": "새 배치",
  "page.err.apiDown": "API 연결 실패 — 백엔드 (uvicorn) 가 떠 있는지 확인하세요.",
  "page.err.apiBoot": "백엔드 부팅 대기 중… (uvicorn 8800 응답이 늦거나 아직 떠 있지 않습니다)",
  "kpi.backlog.label": "백로그 (대기 요청)",
  "kpi.backlog.unit": "건",
  "kpi.backlog.activeBatches": "활성 배치 {n}개",
  "kpi.tp.label": "처리율 (1분)",
  "kpi.tp.unit": "건/s",
  "kpi.tp.activeSamples": "최근 샘플 활성 {n}건",
  "kpi.drain.label": "드레인 ETA (현재 속도)",
  "kpi.drain.starved": "처리율 0 — 워커 부족",
  "kpi.drain.empty": "백로그 비어있음",
  "kpi.drain.rate": "처리율 {rate}",
  "kpi.spot.label": "Spot VM (활성 / 목표 / 최대)",
  "kpi.spot.detail": "ready {ready} · running {running} · prov {prov}",
  "kpi.spot.autostartOff": "풀 자동시작 비활성",
  "pool.title": "풀 확장 진행",
  "pool.meta": "target {target} · current {active}",
  "pool.metaMax": " · max {max}",
  "pool.scaleProgress": "scale progress",
  "pool.scaleUpNodes": "scale-up nodes",
  "pool.overflowTasks": "overflow tasks",
  "pool.evictionsTotal": "evictions (누적)",
  "pool.replaced": "replaced",
  "pool.nodesNone": "spot 노드",
  "pool.nodesList": "spot 노드 · {n}",
  "pool.col.id": "id",
  "pool.col.state": "상태",
  "pool.col.inflight": "inflight",
  "pool.col.outbound": "outbound",
  "pool.recentEvictions": "최근 eviction · {n}",
  "pool.requeued": "재큐잉",
  "chart.title": "큐 깊이 vs VM 수 vs 처리율",
  "chart.legend.backlog": "큐 깊이 (backlog)",
  "chart.legend.vms": "활성 VM 수",
  "chart.legend.tp": "처리율 req/s",
  "chart.collecting": "샘플 수집 중…",
  "chart.notEnough": "샘플 부족 — 몇 초 후 다시 표시됩니다.",
  "batches.title": "배치 큐 · {n}개",
  "batches.meta": "갱신 2초 · 정렬: 최근 생성",
  "batches.empty.loading": "로드 중…",
  "batches.empty.none": "등록된 배치가 없습니다. 우측 상단 “＋ 새 배치”로 추가하세요.",
  "batches.col.batch": "배치",
  "batches.col.requests": "요청 수",
  "batches.col.progress": "진행",
  "batches.col.rate": "처리율",
  "batches.col.eta": "ETA",
  "batches.col.workers": "workers",
  "batches.col.status": "상태",
  "batches.col.actions": "조작",
  "batches.status.done": "완료",
  "batches.status.cancelled": "취소됨",
  "batches.status.failed": "실패",
  "batches.cancel": "취소",
  "batches.nodes": "{n}개 노드",
  "batches.nodes_plural": "{n}개 노드",
  "batches.evictTooltip": "{n}건 요청에 영향을 준 spot eviction 이벤트",
  "dialog.title": "새 배치 등록",
  "dialog.close": "닫기",
  "dialog.source.hint": "정책에 등록된 소스 이름 (기본 generic-http)",
  "dialog.targets.label": "targets · {n}개",
  "dialog.targets.hint": "개행, 쉼표, 세미콜론으로 구분",
  "dialog.workers": "workers",
  "dialog.cancel": "취소",
  "dialog.submitting": "등록 중…",
  "dialog.submit": "＋ 등록 ({n})",
  "lang.toggle": "EN / 한",
  "lang.en": "EN",
  "lang.ko": "한",
  // batches page (scaffold)
  "batches.page.title": "배치 (Batches)",
  "batches.page.sub": "배치별 진행, 워커, eviction 이력",
  "batches.filter.all": "전체",
  "batches.filter.active": "진행 중",
  "batches.filter.terminal": "완료/취소",
  "batches.drawer.title": "배치 상세",
  "batches.drawer.requests": "요청",
  "batches.drawer.nodes": "노드",
  "batches.drawer.evictions": "Eviction",
  "batches.drawer.timeline": "타임라인",
  "batches.page.count": "배치 {n}개",
  "batches.page.refresh": "새로고침",
  "batches.sort.label": "정렬",
  "batches.sort.newest": "최근 생성순",
  "batches.sort.rate": "처리율순",
  "batches.sort.evictions": "Eviction순",
  "batches.list.empty": "현재 필터에 해당하는 배치가 없습니다.",
  "batches.list.col.batch": "배치",
  "batches.list.col.source": "소스",
  "batches.list.col.status": "상태",
  "batches.list.col.progress": "진행",
  "batches.list.col.rate": "처리율",
  "batches.list.col.workers": "workers",
  "batches.list.col.nodes": "노드 수",
  "batches.list.col.evictions": "eviction",
  "batches.list.col.created": "생성",
  "batches.drawer.close": "닫기",
  "batches.drawer.summary": "요약",
  "batches.drawer.summary.total": "요청 수",
  "batches.drawer.summary.completed": "완료",
  "batches.drawer.summary.failed": "실패",
  "batches.drawer.summary.pending": "대기",
  "batches.drawer.summary.rate": "처리율",
  "batches.drawer.summary.eta": "ETA",
  "batches.drawer.summary.workers": "workers",
  "batches.drawer.nodes.empty": "노드별 처리 기록이 아직 없습니다.",
  "batches.drawer.nodes.col.node": "노드",
  "batches.drawer.nodes.col.count": "요청 수",
  "batches.drawer.nodes.col.share": "비중",
  "batches.drawer.evictions.observed": "eviction 이벤트 {n}건 관측됨",
  "batches.drawer.evictions.empty": "이 배치에 영향을 준 eviction 이벤트가 없습니다.",
  "batches.drawer.evictions.requestIds": "영향 받은 요청 ID",
  "batches.drawer.timeline.empty": "기록된 타임라인 이벤트가 없습니다.",
  "batches.drawer.timeline.loading": "타임라인 로드 중…",
  "batches.drawer.cancel": "배치 취소",
  "batches.drawer.notFound": "배치를 찾을 수 없습니다 (이미 제거되었을 수 있습니다).",
  // audit page (scaffold)
  "audit.page.title": "감사 (Audit)",
  "audit.page.sub": "풀/배치 이벤트의 append-only 원장",
  "audit.filter.all": "전체 이벤트",
  "audit.filter.event": "이벤트 종류",
  "audit.empty": "감사 이벤트가 아직 없습니다",
  "audit.payload.show": "payload",
  "audit.payload.hide": "접기",
  // scaling timeline page (scaffold)
  "scaling.page.title": "확장 타임라인 (Scaling Timeline)",
  "scaling.page.sub": "시간별 풀 용량 · 큐 깊이 · 스케일 이벤트",
  "scaling.legend.ready": "ready",
  "scaling.legend.busy": "busy",
  "scaling.legend.prov": "provisioning",
  "scaling.legend.draining": "draining",
  "scaling.legend.event": "이벤트",
  "scaling.chart.title": "풀 용량 (stacked) vs 스케일 이벤트",
  "scaling.chart.meta": "샘플 {samples}개 · 이벤트 {events}개",
  "scaling.markers.title": "스케일 이벤트",
  "scaling.markers.meta": "이벤트 {n}건",
  "scaling.markers.empty": "선택한 시간 범위에 스케일 이벤트가 없습니다",
  "scaling.empty": "샘플 수집 중…",
  // quota page (scaffold)
  "quota.page.title": "쿼터 (Quota)",
  "quota.page.sub": "현재 구독의 Spot vCPU / public IP 쿼터 관측값",
  "quota.meter.label": "Spot vCPU 사용량",
  "quota.meter.sufficient": "충분",
  "quota.meter.insufficient": "부족",
  "quota.notObserved": "쿼터가 아직 관측되지 않았습니다 — provider 가 사용량을 보고하지 않았습니다.",
  "quota.checked": "확인 시각",
  "quota.never": "한 번도 없음",
  "quota.error": "최근 오류",
  "quota.spot_observed": "Spot 쿼터 관측됨",
  "quota.ip_observed": "Public IP 쿼터 관측됨",
  "quota.headroom": "여유",
  "quota.refresh": "지금 갱신",
  // regions page (scaffold)
  "regions.page.title": "리전 (Regions)",
  "regions.page.sub": "Azure 리전별 spot 노드 분포",
  "regions.card.nodes": "노드",
  "regions.card.ready": "ready",
  "regions.card.busy": "busy",
  "regions.card.evictions": "eviction",
  "regions.empty": "관측된 리전이 아직 없습니다",
  "regions.unknown": "(알 수 없음)",
  "regions.nodes_detail": "{region} 리전의 노드",
  "regions.col.id": "id",
  "regions.col.state": "상태",
  "regions.col.outbound": "outbound IP",
  "regions.click_hint": "카드를 클릭하면 해당 리전의 노드 목록이 보입니다",
  "jobs.panel.title": "백그라운드 작업",
  "jobs.panel.empty": "아직 작업이 없습니다",
  "jobs.probe.title": "모든 Azure 리전 스캔",
  "jobs.probe.button": "지금 스캔",
  "jobs.probe.running": "스캔 중…",
  "jobs.probe.hint": "{count}개 리전에 `az vm list-usage` 를 병렬로 실행합니다. 결과는 아래 작업 목록에 나타나며 이 페이지 수치도 갱신됩니다.",
  "jobs.status.running": "실행 중",
  "jobs.status.succeeded": "성공",
  "jobs.status.failed": "실패",
  "jobs.status.cancelled": "취소",
  "jobs.col.name": "이름",
  "jobs.col.status": "상태",
  "jobs.col.started": "시작",
  "jobs.col.duration": "소요",
  "jobs.col.summary": "요약",
};

const DICTS: Record<Lang, Dict> = { en, ko };

function detectInitial(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ko") return stored;
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitial);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", lang);
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const toggle = useCallback(
    () => setLangState((prev) => (prev === "en" ? "ko" : "en")),
    [],
  );

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTS[lang];
      const fallback = DICTS.en;
      const raw = dict[key] ?? fallback[key] ?? key;
      return format(raw, vars);
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, toggle, t }), [lang, setLang, toggle, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
