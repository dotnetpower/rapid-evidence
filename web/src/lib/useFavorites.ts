/**
 * localStorage-backed favorite-set primitive. Used by Regions and
 * Batches pages so the user can pin frequently-used items.
 *
 * Bounded: caller passes a `cap` (default 50) to prevent unbounded
 * growth if the user spam-toggles favorites for years.
 */
import { useCallback, useEffect, useRef, useState } from "react";

function safeLoad(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v) => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function safeSave(key: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    /* quota exceeded — silently drop */
  }
}

export interface FavoritesApi {
  /** Set of currently-favorited identifiers. */
  set: Set<string>;
  /** True if `id` is currently favorited. */
  has: (id: string) => boolean;
  /** Toggle favorite state. Capped at the constructor-provided `cap`. */
  toggle: (id: string) => void;
  /** Remove every favorite. */
  clear: () => void;
}

export interface FavoritesOptions {
  /** Maximum favorites retained. Excess add-attempts are dropped. Default 50. */
  cap?: number;
  /** Invoked when `toggle` would exceed `cap` so the UI can surface a toast. */
  onCapExceeded?: (cap: number) => void;
}

export function useFavorites(
  storageKey: string,
  options: FavoritesOptions | number = {},
): FavoritesApi {
  // Backwards-compatible: useFavorites(key, 50) still works.
  const opts: FavoritesOptions =
    typeof options === "number" ? { cap: options } : options;
  const cap = opts.cap ?? 50;
  const onCapExceededRef = useRef(opts.onCapExceeded);
  onCapExceededRef.current = opts.onCapExceeded;

  const [set, setSet] = useState<Set<string>>(() => safeLoad(storageKey));

  // Skip the initial-mount write: the value we just loaded *from*
  // localStorage is identical to what we'd write back, so the first
  // effect run is wasted I/O on the main thread. Subsequent state
  // changes flip the ref and persist normally.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    safeSave(storageKey, set);
  }, [storageKey, set]);

  const has = useCallback((id: string) => set.has(id), [set]);

  const toggle = useCallback(
    (id: string) => {
      setSet((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else if (next.size < cap) {
          next.add(id);
        } else {
          // Notify outside React's state-update path so consumers can
          // surface a toast without violating the reducer purity rule.
          if (onCapExceededRef.current) {
            queueMicrotask(() => onCapExceededRef.current?.(cap));
          }
          return prev;
        }
        return next;
      });
    },
    [cap],
  );

  const clear = useCallback(() => setSet(new Set()), []);

  return { set, has, toggle, clear };
}
