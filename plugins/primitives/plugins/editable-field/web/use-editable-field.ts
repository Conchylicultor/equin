import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useReportSync,
  type SyncPhase,
} from "@plugins/primitives/plugins/sync-status/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { mapCaret } from "./internal/map-caret";
import { reconcile } from "./internal/reconcile";

export interface UseEditableFieldOptions<T extends string> {
  value: T;
  onSave: (next: T) => void | Promise<void>;
  debounceMs?: number;
  /**
   * Human-readable name of the field being saved. Surfaced by the universal
   * sync-status indicator in the error state (e.g. "Couldn't save Task title")
   * and in the conflict state (e.g. "Task title changed elsewhere").
   */
  label?: string;
}

/**
 * A newer external value the local draft is holding out against: the server (or
 * another tab, or an agent, or an undo patch) moved this field on while the
 * draft carried unsaved edits. The draft stays on screen — a typing user never
 * has text yanked away — and this is how the write that was NOT applied stays
 * visible instead of vanishing.
 */
export interface EditableFieldConflict<T extends string> {
  /** The value the field's source has now, which the draft has not adopted. */
  external: T;
}

export interface EditableField<T extends string> {
  value: T;
  onChange: (next: T) => void;
  onFocus: () => void;
  onBlur: () => void;
  flush: () => Promise<void>;
  isSaving: boolean;
  /** True when the most recent save rejected; cleared on the next success. */
  isError: boolean;
  /** Re-run the save of the current draft (drives the indicator's Retry). */
  retry: () => void;
  /**
   * Non-null while the external value has moved on and the draft has unsaved
   * edits. Reported to sync-status as the `conflict` phase; a consumer can also
   * render its own affordance from it.
   */
  conflict: EditableFieldConflict<T> | null;
  /** Resolve a conflict the other way: take the external value, drop the draft. */
  acceptExternal: () => void;
}

/** A caret to restore once the adopted value has been written to the DOM. */
interface CaretAdoption {
  prev: string;
  next: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none" | null;
}

function isTextEntry(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/**
 * Read the caret out of the element that is rendering this draft, so adopting
 * an external value into a focused field can put it back where it belongs.
 *
 * The element is found through `document.activeElement` rather than a ref the
 * consumer wires: the hook only ever adopts into a *focused* field, and the
 * focused element is by construction the one whose `onFocus` set the flag. Two
 * guards keep that inference honest — it must be a text entry with a selection
 * (an `<input type="number">` has none), and it must currently show exactly the
 * draft we are about to replace. When either fails there is no caret mapping
 * (React DOM's own raw-offset restore still applies); nothing else changes.
 */
function captureCaret(
  prev: string,
  next: string,
  focused: boolean,
): CaretAdoption | null {
  if (!focused) return null;
  const el = document.activeElement;
  if (!isTextEntry(el)) return null;
  if (el.value !== prev) return null;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === null || end === null) return null;
  return { prev, next, start, end, direction: el.selectionDirection };
}

/** How many left-behind values a field remembers as its own past. */
const PAST_CAP = 64;

/**
 * Record that `prev` is no longer what the source should hold. Bounded, oldest
 * first (a Set iterates in insertion order): a long edit session keeps its
 * recent values, which is where a stale view comes from.
 */
function leavePast<T>(past: Set<T>, prev: T): void {
  past.delete(prev);
  past.add(prev);
  if (past.size > PAST_CAP) past.delete(past.values().next().value as T);
}

export function useEditableField<T extends string>(
  opts: UseEditableFieldOptions<T>,
): EditableField<T> {
  const { value, debounceMs = 500, label } = opts;

  const [draft, setDraft] = useState<T>(value);
  const [isSaving, setIsSaving] = useState(false);
  const [isError, setIsError] = useState(false);
  // Explicit "this field's save completed" timestamp, reported to sync-status.
  // A persistent state value (unlike the transient isSaving boolean, which a
  // warm local socket can flip true→false inside one coalesced render).
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState<EditableFieldConflict<T> | null>(
    null,
  );

  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const lastSavedRef = useRef<T>(value);
  // The values this field has LEFT BEHIND: where it started and every save
  // before the latest, since the last value it adopted from elsewhere. One of
  // them showing up again is a stale echo of our own past (see `reconcile`'s
  // `stale`), never someone else's edit.
  const pastRef = useRef<Set<T>>(new Set());
  const onSaveRef = useRef(opts.onSave);
  const pendingCaretRef = useRef<CaretAdoption | null>(null);

  // Keep the latest draft/conflict in refs so the stable callbacks below
  // (`retry` is pulled imperatively by the sync-status indicator) don't churn.
  const draftRef = useLatestRef(draft);
  const conflictRef = useLatestRef(conflict);

  useEffect(() => {
    onSaveRef.current = opts.onSave;
  });

  // Reconcile the external value with the draft on every change to either.
  //
  // This used to be an unconditional `if (focusedRef.current) return`, which
  // silently DROPPED every external write to a focused field — an agent's
  // rename, another tab, a collaborator, an undo patch — and then flushed the
  // stale draft back over it on blur. The rule now is: adopt when the draft has
  // nothing unsaved to lose, and when it does, keep the user's text but report
  // the divergence instead of discarding it.
  useEffect(() => {
    switch (reconcile(value, draft, lastSavedRef.current, pastRef.current)) {
      case "echo":
        // Our own write coming back (or the seed) — the two sides agree.
        setConflict(null);
        return;
      case "stale":
        // A value we already moved past — the source showing an older view of
        // our own writes for a moment. The draft stands; the next view (our
        // write's echo) supersedes it. Not a conflict: nobody else wrote.
        return;
      case "converged":
        // The draft already spells the external value; record the agreement so
        // a later blur doesn't re-save identical text.
        leavePast(pastRef.current, lastSavedRef.current);
        lastSavedRef.current = value;
        setConflict(null);
        return;
      case "conflict":
        // Keep the draft. Re-report the same external value as the SAME object
        // so React bails instead of re-rendering on every keystroke.
        setConflict((prev) =>
          prev && Object.is(prev.external, value) ? prev : { external: value },
        );
        return;
      case "adopt":
        // A pending debounce would re-save the value we are replacing.
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        pendingCaretRef.current = captureCaret(
          draft,
          value,
          focusedRef.current,
        );
        // Someone else's value: the new baseline. What we had left behind is
        // history now, not a stale echo — a later write may legitimately
        // spell one of those values again.
        pastRef.current = new Set();
        lastSavedRef.current = value;
        setDraft(value);
        setConflict(null);
        return;
    }
  }, [value, draft]);

  // Put the caret back after the adopted value has been committed to the DOM.
  // A layout effect runs after React DOM's own selection restore, so this wins;
  // no dep array, because it must fire on exactly the commit that applied it.
  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (!pending) return;
    pendingCaretRef.current = null;
    const el = document.activeElement;
    if (!isTextEntry(el)) return;
    if (el.value !== pending.next) return;
    const start = mapCaret(pending.prev, pending.next, pending.start);
    const end =
      pending.start === pending.end
        ? start
        : mapCaret(pending.prev, pending.next, pending.end);
    el.setSelectionRange(start, end, pending.direction ?? undefined);
  });

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const runSave = useCallback(async (next: T): Promise<void> => {
    const prior = savePromiseRef.current;
    const promise = (async () => {
      if (prior) {
        try {
          await prior;
          // eslint-disable-next-line promise-safety/no-bare-catch
        } catch {
          // Prior save's error is its own problem; don't block this save.
        }
      }
      try {
        await onSaveRef.current(next);
      } catch (err) {
        // Record the failure for the sync-status indicator, then re-throw so
        // flush/callers keep their existing error-propagation semantics.
        setIsError(true);
        throw err;
      }
      leavePast(pastRef.current, lastSavedRef.current);
      // Saved again, it is current, not past.
      pastRef.current.delete(next);
      lastSavedRef.current = next;
      setIsError(false);
      setSavedAt(Date.now());
    })();
    savePromiseRef.current = promise;
    setIsSaving(true);
    try {
      await promise;
    } finally {
      if (savePromiseRef.current === promise) {
        savePromiseRef.current = null;
        setIsSaving(false);
      }
    }
  }, []);

  const onChange = useCallback(
    (next: T) => {
      setDraft(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void runSave(next);
      }, debounceMs);
    },
    [debounceMs, runSave],
  );

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!Object.is(draft, lastSavedRef.current)) {
      await runSave(draft);
      return;
    }
    if (savePromiseRef.current) {
      try {
        await savePromiseRef.current;
        // eslint-disable-next-line promise-safety/no-bare-catch
      } catch {
        // Surface the error to the original caller of runSave, not here.
      }
    }
  }, [draft, runSave]);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    void flush();
  }, [flush]);

  // `retry` stays referentially stable (the sync-status indicator pulls it
  // imperatively) and reads the latest draft off the stable `draftRef.current`.
  const retry = useCallback(() => {
    void runSave(draftRef.current);
  }, [runSave]);

  // The other way out of a conflict: take the external value and drop the
  // draft. It mirrors the effect's `adopt` arm, but reached from an explicit
  // gesture rather than from a value change — the draft it discards is the
  // user's unsaved text, so nothing may do this on its own.
  const acceptExternal = useCallback(() => {
    const pending = conflictRef.current;
    if (!pending) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingCaretRef.current = captureCaret(
      draftRef.current,
      pending.external,
      focusedRef.current,
    );
    // Theirs is the new baseline, as an adopt's is.
    pastRef.current = new Set();
    lastSavedRef.current = pending.external;
    setDraft(pending.external);
    setConflict(null);
  }, []);

  // Auto-report to the universal sync-status indicator. Harmless no-op when no
  // <SyncStatusProvider> is above (unit tests, non-surface mounts). A failed
  // save outranks a conflict: it is the state with an action attached.
  const phase: SyncPhase = isError
    ? "error"
    : conflict
      ? "conflict"
      : isSaving
        ? "syncing"
        : "idle";
  useReportSync({ phase, label, retry: isError ? retry : undefined, savedAt });

  return {
    value: draft,
    onChange,
    onFocus,
    onBlur,
    flush,
    isSaving,
    isError,
    retry,
    conflict,
    acceptExternal,
  };
}
