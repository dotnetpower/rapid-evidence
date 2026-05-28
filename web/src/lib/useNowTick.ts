import { useEffect, useState } from "react";

/**
 * Re-renders the caller at the given interval so any
 * `Date.now()`-derived display (relative timestamps, "ago" labels)
 * stays fresh even when no query refetched.
 *
 * Defaults to 1 s — coarse enough that 60+ subscribers do not cost
 * meaningful CPU, fine enough that "2s ago" doesn't sit at "2s" for
 * a minute.
 */
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
