import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RegionSummary } from "../../lib/api";
import { geoFor, REGION_GEO } from "./regionGeo";
import { useI18n } from "../../lib/i18n";

interface QuotaEntry {
  headroom: number | null;
  limit: number | null;
  used: number | null;
  observed: boolean;
  error: string | null;
}

interface RegionsMapProps {
  regions: RegionSummary[];
  /** keyed by region name */
  quotaByRegion?: Record<string, QuotaEntry>;
  selected: string | null;
  onSelect: (region: string | null) => void;
}

// Pick marker colour by status:
// - active: at least one node alive in that region (busy/ready)
// - capacity-only: scanned, has headroom, no nodes yet
// - exhausted: scanned, headroom = 0
// - error: probe failed
// - unknown: no data
function markerStyle(
  hasNodes: boolean,
  busy: number,
  evictions: number,
  q?: QuotaEntry,
): { color: string; fill: string; radius: number } {
  if (busy > 0) {
    return { color: "#a06bff", fill: "#a06bff", radius: 9 };
  }
  if (hasNodes) {
    return { color: "#5db075", fill: "#5db075", radius: 8 };
  }
  if (q?.error) {
    return { color: "#e06c75", fill: "#e06c75", radius: 6 };
  }
  if (q && q.observed) {
    if ((q.headroom ?? 0) === 0) {
      return { color: "#e6c47a", fill: "#e6c47a", radius: 6 };
    }
    return { color: "#4fc1ff", fill: "#4fc1ff", radius: 7 };
  }
  if (evictions > 0) {
    return { color: "#e06c75", fill: "#e06c75", radius: 6 };
  }
  return { color: "#777", fill: "#888", radius: 5 };
}

function FitToContent({ keys }: { keys: string[] }) {
  const map = useMap();
  const fittedRef = useRef(false);
  useEffect(() => {
    // Only auto-fit once — refits on every poll fight the user's
    // manual zoom/pan and feel hostile.
    if (fittedRef.current) return;
    const pts: L.LatLngTuple[] = keys
      .map((k) => geoFor(k))
      .filter((g): g is NonNullable<ReturnType<typeof geoFor>> => Boolean(g))
      .map((g) => [g.lat, g.lon] as L.LatLngTuple);
    if (pts.length === 0) return;
    fittedRef.current = true;
    if (pts.length === 1) {
      map.setView(pts[0], 4);
      return;
    }
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds.pad(0.2), { animate: false });
  }, [keys, map]);
  return null;
}

export function RegionsMap({ regions, quotaByRegion, selected, onSelect }: RegionsMapProps) {
  const { t } = useI18n();

  const knownKeys = useMemo(() => {
    const ks = new Set<string>();
    for (const r of regions) {
      if (r.region && REGION_GEO[r.region]) ks.add(r.region);
    }
    if (quotaByRegion) {
      for (const k of Object.keys(quotaByRegion)) {
        if (REGION_GEO[k]) ks.add(k);
      }
    }
    return Array.from(ks);
  }, [regions, quotaByRegion]);

  const regionMap = useMemo(() => {
    const m = new Map<string, RegionSummary>();
    for (const r of regions) {
      if (r.region) m.set(r.region, r);
    }
    return m;
  }, [regions]);

  return (
    <div className="regions-map-wrap">
      <MapContainer
        center={[20, 10]}
        zoom={2}
        minZoom={1}
        worldCopyJump
        scrollWheelZoom={false}
        style={{ height: 360, width: "100%", background: "#1a1a1a" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
        />
        <FitToContent keys={knownKeys} />
        {knownKeys.map((key) => {
          const geo = REGION_GEO[key];
          const summary = regionMap.get(key);
          const quota = quotaByRegion?.[key];
          const ready = summary?.ready ?? 0;
          const busy = summary?.busy ?? 0;
          const total = summary?.nodes ?? 0;
          const evictions = summary?.evictions_recent ?? 0;
          const hasNodes = total > 0;
          const style = markerStyle(hasNodes, busy, evictions, quota);
          const isSel = selected === key;
          return (
            <CircleMarker
              key={key}
              center={[geo.lat, geo.lon]}
              radius={isSel ? style.radius + 3 : style.radius}
              pathOptions={{
                color: isSel ? "#fff" : style.color,
                weight: isSel ? 2 : 1,
                fillColor: style.fill,
                fillOpacity: isSel ? 0.9 : 0.65,
              }}
              eventHandlers={{
                click: () => onSelect(isSel ? null : key),
              }}
            >
              <Tooltip direction="top" offset={[0, -4]} opacity={1}>
                <div style={{ minWidth: 140 }}>
                  <div style={{ fontWeight: 600 }}>{geo.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    {t("regions.map.tooltip_nodes", { n: total, ready, busy })}
                  </div>
                  {evictions > 0 && (
                    <div style={{ fontSize: 11, color: "#e6c47a" }}>
                      {t("regions.map.tooltip_evictions", { n: evictions })}
                    </div>
                  )}
                  {quota?.error && (
                    <div style={{ fontSize: 11, color: "#e06c75" }}>{quota.error}</div>
                  )}
                  {quota && quota.observed && quota.limit !== null && (
                    <div style={{ fontSize: 11 }}>
                      {t("regions.map.tooltip_quota", {
                        used: quota.used ?? 0,
                        limit: quota.limit,
                        headroom: quota.headroom ?? 0,
                      })}
                    </div>
                  )}
                </div>
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
      <div className="regions-map-legend">
        <span><span className="dot" style={{ background: "#a06bff" }} /> {t("regions.map.legend.busy")}</span>
        <span><span className="dot" style={{ background: "#5db075" }} /> {t("regions.map.legend.ready")}</span>
        <span><span className="dot" style={{ background: "#4fc1ff" }} /> {t("regions.map.legend.capacity")}</span>
        <span><span className="dot" style={{ background: "#e6c47a" }} /> {t("regions.map.legend.exhausted")}</span>
        <span><span className="dot" style={{ background: "#e06c75" }} /> {t("regions.map.legend.error")}</span>
        <span><span className="dot" style={{ background: "#777" }} /> {t("regions.map.legend.unknown")}</span>
      </div>
    </div>
  );
}
