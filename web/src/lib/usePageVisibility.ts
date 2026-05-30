/**
 * Page Visibility-aware hook. Returns `true` when the tab is in the
 * foreground and `false` when it is hidden, suspended, or in another
 * window.
 *
 * Used to throttle / pause TanStack Query refetch loops when the user
 * is not looking. Avoids cost on a parked tab and provides an instant
 * refetch when the user comes back.
 *
 * SSR-safe: `document` access guarded.
 */
import { useEffect, useState } from "react";

export function usePageVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => {
      setVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return visible;
}
