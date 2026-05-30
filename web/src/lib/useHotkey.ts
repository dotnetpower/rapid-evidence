/**
 * Tiny keyboard-hotkey hook used by pages that want a global accelerator
 * (e.g. Ctrl/Cmd+N to open the New Batch dialog).
 *
 * Bounded by design: registers one document-level keydown listener on
 * mount, removes it on unmount. Skips when the user is typing into an
 * input/textarea/contentEditable so we never hijack typing.
 *
 * Limited on purpose to "Ctrl/Cmd + single letter" — anything richer
 * deserves a real command palette, not more flags here.
 */
import { useEffect, useRef } from "react";

interface HotkeyOptions {
  /** Letter to match (case-insensitive). e.g. "n" for Ctrl+N. */
  key: string;
  /** Callback invoked when the hotkey fires. */
  onTrigger: () => void;
  /** Disable temporarily without unmounting the consumer. Default true. */
  enabled?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * Listens for `Ctrl+<key>` / `Cmd+<key>` and calls `onTrigger`.
 * Suppressed while a text input has focus.
 *
 * `onTrigger` is captured by ref so callers may pass an inline arrow
 * without rebinding the document listener on every parent render.
 */
export function useCtrlOrCmdHotkey({ key, onTrigger, enabled = true }: HotkeyOptions): void {
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  useEffect(() => {
    if (!enabled) return;
    const wanted = key.toLowerCase();
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== wanted) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      onTriggerRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [key, enabled]);
}
