import { useEffect, useState } from "react";

/**
 * Re-renders the caller at the given interval so any
 * `Date.now()`-derived display (relative timestamps, "ago" labels)
 * stays fresh even when no query refetched.
 *
 * Design: each distinct interval value shares a **single** wall-clock
 * `setInterval` and notifies every subscriber. This bounds wall-clock
 * timer load to O(distinct intervals) instead of O(callers).
 * Critical because pages render many <EventRow>/<RegionRow> components
 * that each subscribe at the same 1 s cadence — without sharing, a
 * 500-event audit tail would spawn 500 timers.
 *
 * Defaults to 1 s — coarse enough that 60+ subscribers do not cost
 * meaningful CPU, fine enough that "2s ago" doesn't sit at "2s" for
 * a minute.
 */

type Listener = (now: number) => void;

interface Channel {
  listeners: Set<Listener>;
  handle: ReturnType<typeof setInterval> | null;
  last: number;
}

// Module-scoped: shared across the entire app. Keys are interval-ms.
const channels = new Map<number, Channel>();

function ensureChannel(intervalMs: number): Channel {
  let ch = channels.get(intervalMs);
  if (ch) return ch;
  ch = { listeners: new Set<Listener>(), handle: null, last: Date.now() };
  channels.set(intervalMs, ch);
  return ch;
}

function startIfNeeded(ch: Channel, intervalMs: number): void {
  if (ch.handle !== null) return;
  ch.handle = setInterval(() => {
    ch.last = Date.now();
    // Snapshot listeners so a listener that unsubscribes during
    // notification doesn't mutate the set mid-iteration.
    for (const fn of Array.from(ch.listeners)) fn(ch.last);
  }, intervalMs);
}

function subscribe(intervalMs: number, fn: Listener): () => void {
  const ch = ensureChannel(intervalMs);
  ch.listeners.add(fn);
  startIfNeeded(ch, intervalMs);
  return () => {
    ch.listeners.delete(fn);
    if (ch.listeners.size === 0 && ch.handle !== null) {
      clearInterval(ch.handle);
      ch.handle = null;
    }
  };
}

export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => subscribe(intervalMs, setNow), [intervalMs]);
  return now;
}
