import { useRef, useState, type Dispatch, type SetStateAction } from "react";

/**
 * How a piece of React state declared what a remount does to it, readable
 * from outside the component (the dev unmount detector, `loss-detector`):
 *
 * - `kept` — the state under a `useKept` / `useDraft` binding: a remount
 *   gives it back from storage;
 * - `transient` — `useTransient("<why>")`: lost on a remount by design.
 *
 * A mark is the value of a `useRef` called immediately before the state hook
 * it marks, so it sits in the component's hook list one place ahead of that
 * hook, where a fiber walk finds it. Nothing else is in it: a ref holding one
 * of these objects is a mark, whoever reads it.
 */
export type StateMark =
  | { readonly stateMark: "kept" }
  | { readonly stateMark: "transient"; readonly reason: string };

const KEPT_MARK: StateMark = Object.freeze({ stateMark: "kept" });

/** The mark `value` is, or `null` when it is not one. */
export function stateMarkOf(value: unknown): StateMark | null {
  if (typeof value !== "object" || value === null) return null;
  const mark = (value as { stateMark?: unknown }).stateMark;
  if (mark === "kept") return KEPT_MARK;
  if (mark === "transient") {
    const reason = (value as { reason?: unknown }).reason;
    return typeof reason === "string"
      ? { stateMark: "transient", reason }
      : null;
  }
  return null;
}

/** Mark the state hook called right after this one as kept (`useKeptEntry`). */
export function useKeptMark(): void {
  useRef(KEPT_MARK);
}

/**
 * `useState` for state that is throwaway by design — a hover, a busy flag, a
 * menu's open flag, a value that only mirrors something kept elsewhere — and
 * says why. A remount (a reload, or a hidden tab unloaded by tab residency)
 * loses it, and the dev unmount detector (`loss-detector`) does not report
 * it. State the user would miss is never transient: keep it (`useKept`).
 *
 * ```ts
 * const [hovered, setHovered] = useTransient("hover: gone with the pointer", false);
 * ```
 */
export function useTransient<T>(
  reason: string,
  initialValue: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  if (reason.trim() === "")
    throw new Error("useTransient(reason): say why this state may be lost");
  useRef<StateMark>({ stateMark: "transient", reason });
  return useState<T>(initialValue);
}
