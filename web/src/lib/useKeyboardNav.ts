/**
 * Global keyboard navigation hook + shortcut handler.
 *
 * Listens at the document level for the "g + <key>" leader-key style
 * shortcuts (gmail-inspired) plus single-key actions like "?" for
 * the help drawer.
 *
 * Why a leader key: avoids collisions with single-letter shortcuts
 * baked into the browser (e.g. "/" for search). The two-key sequence
 * `g`-then-`t` is unambiguous and easy to type with one hand.
 *
 * Skips dispatch when focus is in a text input / textarea / select /
 * contenteditable so the user can still type letters into search
 * boxes without triggering navigation.
 *
 * Bounded state: a single `leaderActive` boolean cleared after 1.2 s
 * if no follow-up key arrives. No unbounded growth.
 */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

export interface ShortcutSpec {
  /** Path to navigate to when the leader sequence `g <key>` is typed. */
  path: string;
  /** Optional human-readable label for the help drawer. */
  label?: string;
}

const LEADER_TIMEOUT_MS = 1200;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Wires global navigation shortcuts onto the document.
 *
 * @param shortcuts map of single key character (e.g. "t") to spec
 * @param onHelp optional callback when the user presses `?`
 *
 * Note: `shortcuts` MUST be a stable reference (wrap with useMemo at
 * the call site) otherwise the leader-key state is wiped on every
 * re-render. `onHelp` is internally captured by ref so callers may
 * pass an inline arrow without thrashing the document listener.
 */
export function useKeyboardNav(
  shortcuts: Record<string, ShortcutSpec>,
  onHelp?: () => void,
): void {
  const navigate = useNavigate();
  // Refs absorb identity changes of the callbacks/data so the document
  // listener registers exactly once per shortcuts-identity change.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const onHelpRef = useRef(onHelp);
  onHelpRef.current = onHelp;

  useEffect(() => {
    let leaderActive = false;
    let leaderTimer: number | null = null;

    const clearLeader = () => {
      leaderActive = false;
      if (leaderTimer !== null) {
        window.clearTimeout(leaderTimer);
        leaderTimer = null;
      }
    };

    const handle = (event: KeyboardEvent) => {
      // Ignore when the user is typing into a form control.
      if (isTypingTarget(event.target)) return;
      // Ignore when a modifier we don't own is held. Allow plain `g`
      // and plain `?` to pass; Shift is needed for `?` on most layouts.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const key = event.key;

      // Help drawer
      if (!leaderActive && (key === "?" || key === "/")) {
        if (key === "?" && onHelpRef.current) {
          event.preventDefault();
          onHelpRef.current();
          return;
        }
        // Don't intercept "/" — leave for native quick-find.
      }

      // Leader key
      if (!leaderActive && key === "g") {
        leaderActive = true;
        leaderTimer = window.setTimeout(clearLeader, LEADER_TIMEOUT_MS);
        return;
      }

      // Follow-up after leader
      if (leaderActive) {
        clearLeader();
        const spec = shortcutsRef.current[key.toLowerCase()];
        if (spec) {
          event.preventDefault();
          navigate(spec.path);
        }
        return;
      }
    };

    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      clearLeader();
    };
  }, [navigate]);
}
