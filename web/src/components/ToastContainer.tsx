/**
 * Toast container — renders the global toast queue.
 *
 * Single instance, mounted at AppShell. Pure visual layer over
 * `useToast` pub/sub state.
 */
import { dismissToast, useToasts, type Toast } from "../lib/useToast";

function kindIcon(kind: Toast["kind"]): string {
  if (kind === "success") return "✓";
  if (kind === "error") return "✕";
  return "ⓘ";
}

export function ToastContainer() {
  const toasts = useToasts();
  return (
    <div
      className="toast-container"
      role="region"
      aria-live="polite"
      aria-label="notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-icon" aria-hidden="true">
            {kindIcon(toast.kind)}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="dismiss notification"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
