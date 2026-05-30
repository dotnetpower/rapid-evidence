/**
 * Keyboard shortcut help modal.
 *
 * Triggered by `?` (via `useKeyboardNav`) or by clicking the `⌨ ?`
 * button in the status bar. Dismissed on Escape, backdrop click, or
 * the close button.
 *
 * Focus management:
 *   - On open: focus the close button.
 *   - Tab / Shift+Tab is trapped inside the dialog (Tab off the last
 *     focusable wraps to the first, Shift+Tab off the first wraps to
 *     the last). Without this the user could Tab into the page beneath
 *     a supposedly modal dialog — an a11y regression.
 *   - On close: restore focus to whatever was active before the modal
 *     opened (usually the status-bar `⌨ ?` button) so keyboard users
 *     don't lose their place.
 */
import { useEffect, useRef } from "react";
import { useI18n } from "../lib/i18n";

interface ShortcutHelpProps {
  onClose: () => void;
}

const NAV_KEYS: Array<[string, string]> = [
  ["g t", "title.crumb.throughput"],
  ["g r", "title.crumb.regions"],
  ["g b", "title.crumb.batches"],
  ["g s", "title.crumb.scaling"],
  ["g q", "title.crumb.quota"],
  ["g a", "title.crumb.audit"],
];

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus only if the previously-focused element is still in
      // the document (could have been replaced by a route change).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
      >
        <div className="modal-head">
          <h2 id="shortcut-help-title">{t("shortcut.help")}</h2>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label={t("shortcut.help.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">{t("shortcut.nav.intro")}</p>
          <ul className="shortcut-list">
            {NAV_KEYS.map(([keys, labelKey]) => (
              <li key={keys}>
                <kbd>{keys.split(" ")[0]}</kbd>
                <span className="plus">+</span>
                <kbd>{keys.split(" ")[1]}</kbd>
                <span className="label">{t(labelKey)}</span>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginTop: 12 }}>
            {t("shortcut.action.intro")}
          </p>
          <ul className="shortcut-list">
            <li>
              <kbd>?</kbd>
              <span className="label">{t("shortcut.help")}</span>
            </li>
            <li>
              <kbd>Ctrl</kbd>
              <span className="plus">+</span>
              <kbd>N</kbd>
              <span className="label">{t("shortcut.action.newBatch")}</span>
            </li>
            <li>
              <kbd>P</kbd>
              <span className="label">{t("shortcut.action.pauseTail")}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
