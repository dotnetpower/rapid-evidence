/**
 * Document.title sync hook — keeps the browser tab title in sync
 * with the active page and (optionally) a live counter such as the
 * pending backlog or running batch count.
 *
 * The previous title is restored on unmount so navigating away from
 * an instrumented page doesn't leave a stale counter behind.
 */
import { useEffect } from "react";

const BASE_TITLE = "rapid-evidence";

export function useDocumentTitle(
  title: string,
  badge?: string | number | null,
): void {
  useEffect(() => {
    const prev = document.title;
    const prefix =
      badge != null && badge !== "" && badge !== 0 ? `(${badge}) ` : "";
    document.title = `${prefix}${title} · ${BASE_TITLE}`;
    return () => {
      document.title = prev;
    };
  }, [title, badge]);
}
