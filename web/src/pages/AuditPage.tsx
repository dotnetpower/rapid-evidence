import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type RuntimeEvent } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useToast } from "../lib/useToast";
import { downloadCsv, csvDateStamp } from "../lib/csv";
import { EventFilterBar } from "../components/audit/EventFilterBar";
import { EventRow } from "../components/audit/EventRow";
import "../styles/audit.css";

const MAX_BUFFERED_EVENTS = 500;
const REFETCH_INTERVAL_MS = 2000;

type SortDir = "newest" | "oldest";

interface StoredEvent extends RuntimeEvent {
  _id: number;
}

function eventFingerprint(event: RuntimeEvent): string {
  return `${event.timestamp}|${event.event_type}|${JSON.stringify(event.payload ?? {})}`;
}

function matchesQuery(event: StoredEvent, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (event.event_type.toLowerCase().includes(needle)) return true;
  try {
    return JSON.stringify(event.payload ?? {}).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

export function AuditPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sortDir, setSortDir] = useState<SortDir>("newest");
  const [paused, setPaused] = useState(false);
  const sinceRef = useRef<string | undefined>(undefined);
  const idRef = useRef(0);
  const fingerprintsRef = useRef<Set<string>>(new Set());

  const tail = useQuery({
    queryKey: ["audit-events-tail"],
    queryFn: async () => {
      const since = sinceRef.current;
      const body = await api.listEvents({ since, limit: 200 });
      return body.events;
    },
    // Paused: polling halts; existing buffer remains intact so the operator
    // can read without the list jumping. `refetchInterval: false` is the
    // single source of truth for pause — no redundant `enabled` flag.
    refetchInterval: paused ? false : REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_INTERVAL_MS - 100,
  });

  useEffect(() => {
    if (paused) return;
    const fresh = tail.data;
    if (!fresh || fresh.length === 0) return;
    const additions: StoredEvent[] = [];
    for (const event of fresh) {
      const fp = eventFingerprint(event);
      if (fingerprintsRef.current.has(fp)) continue;
      fingerprintsRef.current.add(fp);
      additions.push({ ...event, _id: ++idRef.current });
    }
    if (additions.length === 0) return;
    setEvents((prev) => [...additions, ...prev].slice(0, MAX_BUFFERED_EVENTS));
    const newest = fresh[fresh.length - 1]?.timestamp;
    if (newest && (!sinceRef.current || newest > sinceRef.current)) {
      sinceRef.current = newest;
    }
  }, [tail.data, paused]);

  // Bound the fingerprint set to the events currently retained so long
  // sessions can't leak memory (events drop out at the MAX_BUFFERED_EVENTS
  // tail but fingerprints would otherwise live forever). Runs after every
  // state update, but only rebuilds the Set when the buffer is full.
  useEffect(() => {
    if (events.length < MAX_BUFFERED_EVENTS) return;
    const kept = new Set<string>();
    for (const e of events) kept.add(eventFingerprint(e));
    fingerprintsRef.current = kept;
  }, [events]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of events) map[e.event_type] = (map[e.event_type] ?? 0) + 1;
    return map;
  }, [events]);

  const available = useMemo(() => Object.keys(counts).sort(), [counts]);

  const ordered = useMemo(() => {
    // Fused single-pass filter: previous version walked the 500-event
    // buffer three times (sort copy + type filter + text filter) on every
    // keystroke / 2 s poll. Fusing the two filters into one loop and
    // sorting only the surviving rows makes the search bar feel
    // responsive even with the buffer full.
    const wantsType = selected.size > 0;
    const filtered: StoredEvent[] = [];
    for (const e of events) {
      if (wantsType && !selected.has(e.event_type)) continue;
      if (!matchesQuery(e, query)) continue;
      filtered.push(e);
    }
    filtered.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        const cmp = a.timestamp < b.timestamp ? 1 : -1;
        return sortDir === "newest" ? cmp : -cmp;
      }
      const idCmp = b._id - a._id;
      return sortDir === "newest" ? idCmp : -idCmp;
    });
    return filtered;
  }, [events, selected, query, sortDir]);

  // Tab title shows the buffered event count, so operators see growth at a glance.
  useDocumentTitle(t("audit.page.title"), events.length > 0 ? events.length : null);

  // `P` (no modifiers) toggles tail pause — documented in the help modal.
  // Skips when the user is typing into an input so the search box still
  // accepts the letter "p".
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "p" && event.key !== "P") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      event.preventDefault();
      setPaused((p) => !p);
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, []);

  const toggleType = (eventType: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(eventType)) next.delete(eventType);
      else next.add(eventType);
      return next;
    });
  };

  const resetFilter = () => setSelected(new Set());

  const togglePause = () => setPaused((p) => !p);

  function exportCsv() {
    if (ordered.length === 0) {
      toast(t("toast.csvEmpty"), "info");
      return;
    }
    const headers = ["timestamp", "event_type", "payload_json"];
    const data = ordered.map((e) => [
      e.timestamp,
      e.event_type,
      JSON.stringify(e.payload ?? {}),
    ]);
    downloadCsv(`audit-${csvDateStamp()}.csv`, headers, data);
    toast(t("toast.csvExported", { n: data.length }), "success");
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("audit.page.title")}</h1>
          <div className="sub">{t("audit.page.sub")}</div>
        </div>
      </div>

      <div className={`audit-tail-bar${paused ? " paused" : ""}`}>
        <span className="audit-tail-bar__dot" aria-hidden />
        <span className="audit-tail-bar__label">
          {paused ? t("audit.tail.paused") : t("audit.tail.live")}
        </span>
        <input
          type="search"
          className="search-input"
          placeholder={t("audit.search.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("audit.search.placeholder")}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button
          type="button"
          className="btn"
          onClick={() =>
            setSortDir((d) => (d === "newest" ? "oldest" : "newest"))
          }
          title={t("audit.sort.toggle")}
        >
          {sortDir === "newest" ? "↓ " + t("audit.sort.newest") : "↑ " + t("audit.sort.oldest")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={togglePause}
          aria-pressed={paused}
        >
          {paused ? "▶ " + t("audit.tail.resume") : "⏸ " + t("audit.tail.pause")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={exportCsv}
          disabled={ordered.length === 0}
          title={t("regions.export.csv")}
        >
          ⤓ CSV
        </button>
      </div>

      <EventFilterBar
        available={available}
        selected={selected}
        onToggle={toggleType}
        onReset={resetFilter}
        counts={counts}
        total={events.length}
      />

      {tail.isError && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {t("page.err.apiDown")}
        </div>
      )}

      {ordered.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          {events.length === 0 ? t("audit.empty") : t("audit.empty.filtered")}
        </div>
      ) : (
        <ul className="event-list">
          {ordered.map((event) => (
            <EventRow key={event._id} event={event} />
          ))}
        </ul>
      )}
    </>
  );
}

