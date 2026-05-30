/**
 * Pure region filter + sort helpers used by the Regions page toolbar.
 *
 * Keeping the logic in a separate file means it can be unit-tested without
 * mounting React, and the toolbar component stays focused on UI concerns.
 */
import type { RegionSummary } from "../../lib/api";
import type { RegionProbe } from "./RegionQuotaTable";

export type RegionSortKey =
  | "region-asc"
  | "region-desc"
  | "headroom-desc"
  | "headroom-asc"
  | "used-desc"
  | "observed-first";

export const REGION_SORT_KEYS: ReadonlyArray<RegionSortKey> = [
  "region-asc",
  "region-desc",
  "headroom-desc",
  "headroom-asc",
  "used-desc",
  "observed-first",
];

function regionLabel(r: RegionSummary | RegionProbe): string {
  return r.region ?? "";
}

function matchesQuery(label: string, q: string): boolean {
  if (!q) return true;
  return label.toLowerCase().includes(q.toLowerCase());
}

export function filterRegions(
  rows: ReadonlyArray<RegionSummary>,
  query: string,
): RegionSummary[] {
  const q = query.trim();
  if (!q) return rows.slice();
  return rows.filter((r) => matchesQuery(regionLabel(r), q));
}

export function filterProbes(
  probes: ReadonlyArray<RegionProbe>,
  query: string,
): RegionProbe[] {
  const q = query.trim();
  if (!q) return probes.slice();
  return probes.filter((p) => matchesQuery(regionLabel(p), q));
}

/**
 * Sort probes by `key`, then promote favorited regions to the top
 * (favorites preserve their relative ordering from the chosen sort).
 *
 * Returns a new array — never mutates the input.
 */
export function sortProbes(
  probes: ReadonlyArray<RegionProbe>,
  key: RegionSortKey,
  favorites: ReadonlySet<string>,
): RegionProbe[] {
  const copy = probes.slice();
  copy.sort((a, b) => compareProbes(a, b, key));
  if (favorites.size === 0) return copy;
  const fav: RegionProbe[] = [];
  const rest: RegionProbe[] = [];
  for (const p of copy) {
    if (p.region && favorites.has(p.region)) fav.push(p);
    else rest.push(p);
  }
  return fav.concat(rest);
}

function compareProbes(a: RegionProbe, b: RegionProbe, key: RegionSortKey): number {
  switch (key) {
    case "region-asc":
      return regionLabel(a).localeCompare(regionLabel(b));
    case "region-desc":
      return regionLabel(b).localeCompare(regionLabel(a));
    case "headroom-desc":
      return (b.headroom ?? -1) - (a.headroom ?? -1);
    case "headroom-asc":
      return (a.headroom ?? Number.POSITIVE_INFINITY) - (b.headroom ?? Number.POSITIVE_INFINITY);
    case "used-desc":
      return (b.used ?? -1) - (a.used ?? -1);
    case "observed-first":
      return Number(b.observed) - Number(a.observed);
  }
}
