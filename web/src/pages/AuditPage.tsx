import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type RuntimeEvent } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { EventFilterBar } from "../components/audit/EventFilterBar";
import { EventRow } from "../components/audit/EventRow";
import "../styles/audit.css";

const MAX_BUFFERED_EVENTS = 500;
const REFETCH_INTERVAL_MS = 2000;

interface StoredEvent extends RuntimeEvent {
  _id: number;
}

function eventFingerprint(event: RuntimeEvent): string {
  return `${event.timestamp}|${event.event_type}|${JSON.stringify(event.payload ?? {})}`;
}

export function AuditPage() {
  const { t } = useI18n();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_INTERVAL_MS - 100,
  });

  useEffect(() => {
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
  }, [tail.data]);

  const available = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.event_type);
    return Array.from(set).sort();
  }, [events]);

  const ordered = useMemo(() => {
    const sorted = [...events].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? 1 : -1;
      }
      return b._id - a._id;
    });
    if (selected.size === 0) return sorted;
    return sorted.filter((e) => selected.has(e.event_type));
  }, [events, selected]);

  const toggleType = (eventType: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(eventType)) next.delete(eventType);
      else next.add(eventType);
      return next;
    });
  };

  const resetFilter = () => setSelected(new Set());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("audit.page.title")}</h1>
          <div className="sub">{t("audit.page.sub")}</div>
        </div>
      </div>

      <EventFilterBar
        available={available}
        selected={selected}
        onToggle={toggleType}
        onReset={resetFilter}
      />

      {tail.isError && (
        <div className="error-banner" style={{ marginBottom: 12 }}>
          {t("page.err.apiDown")}
        </div>
      )}

      {ordered.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          {t("audit.empty")}
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
