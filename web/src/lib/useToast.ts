/**
 * Lightweight toast notification system.
 *
 * Design:
 *   - Single in-memory queue, bounded at MAX_TOASTS (oldest dropped).
 *   - Stable monotonically-increasing IDs, no growth — `++idSeq`
 *     wraps safely at 2^53 (effectively never).
 *   - Auto-dismiss timers tracked per-toast and cleared on manual
 *     dismiss / unmount, no leak.
 *   - ARIA live region in `ToastContainer` for screen-reader users.
 *
 * Why pub/sub instead of context: lets non-React modules (api fetch
 * error path, future hotkey handlers) post toasts without prop
 * drilling. The container is rendered once at `AppShell`.
 */
import { useEffect, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Milliseconds before auto-dismiss; 0 = sticky. */
  ttlMs: number;
  createdAt: number;
}

const MAX_TOASTS = 5;
const DEFAULT_TTL_MS: Record<ToastKind, number> = {
  success: 3000,
  info: 3500,
  error: 6000,
};

type Listener = (toasts: Toast[]) => void;

let idSeq = 0;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

function scheduleDismiss(id: number, ttlMs: number): void {
  if (ttlMs <= 0) return;
  const handle = setTimeout(() => {
    dismissToast(id);
  }, ttlMs);
  timers.set(id, handle);
}

export function pushToast(
  message: string,
  kind: ToastKind = "info",
  ttlMs?: number,
): number {
  const id = ++idSeq;
  const toast: Toast = {
    id,
    kind,
    message,
    ttlMs: ttlMs ?? DEFAULT_TTL_MS[kind],
    createdAt: Date.now(),
  };
  toasts = [...toasts, toast];
  // Drop oldest when over cap.
  if (toasts.length > MAX_TOASTS) {
    const dropped = toasts[0];
    toasts = toasts.slice(1);
    const t = timers.get(dropped.id);
    if (t) {
      clearTimeout(t);
      timers.delete(dropped.id);
    }
  }
  scheduleDismiss(id, toast.ttlMs);
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== before) emit();
}

export function dismissAllToasts(): void {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
  toasts = [];
  emit();
}

export function useToasts(): Toast[] {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    setList(toasts);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** Convenience hook for components that only need to push. */
export function useToast(): (message: string, kind?: ToastKind, ttlMs?: number) => number {
  return pushToast;
}
