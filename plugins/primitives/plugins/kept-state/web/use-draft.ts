import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useStore,
  type ScopedStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import type { KeptBinding, KeptHandle } from "../core";
import {
  clearDraft as clearStoredDraft,
  flushDraft,
  readDraft,
  scheduleDraftWrite,
} from "./draft-storage";
import { useKeptMark } from "./state-marks";

/** How a stored value is read back: as is (a store's own schema), or reparsed. */
type Parse<T> = (stored: unknown) => T | null;

/** A shown value and the entry it belongs to (`store.key(id)`; `null`: memory only). */
interface Shown<T> {
  entry: string | null;
  value: T;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The one reactive core under `useDraft` and `useKept`: a `useState` over the
 * entry `id` of `store`, or over memory alone when `store` is `null` (view
 * state outside every `KeepScope`). Writes are batched to the end of the frame
 * (`scheduleDraftWrite`; `flushKept` on pagehide).
 */
export function useKeptEntry<T>(
  store: Store<unknown> | null,
  id: string,
  initialValue: T | (() => T),
  parse: Parse<T>,
): KeptBinding<T> {
  // Resolve initialValue once via useState lazy-init: a stable value (its setter
  // is never called) that can seed the storage read and the effect deps without
  // a render-phase ref read.
  const [resolvedInitial] = useState<T>(() =>
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue,
  );

  const read = useCallback((): T => {
    if (store === null) return resolvedInitial;
    const stored = readDraft(store, { scope: id });
    if (stored === null) return resolvedInitial;
    return parse(stored) ?? resolvedInitial;
  }, [store, id, resolvedInitial, parse]);

  // The value below is kept: a remount reads it back from storage, so the dev
  // unmount detector (loss-detector) must not report it as lost.
  useKeptMark();
  // What is shown, stamped with the entry it was read from or written to
  // (`null`: memory only). A render whose entry differs from the stamp never
  // returns the stamped value: it re-reads its own entry during that render,
  // so no render (and no child effect run after it) can see another entry's
  // value, and an updater never builds on one.
  const entry = store === null ? null : store.key(id);
  const [shown, setShown] = useState<Shown<T>>(() => ({
    entry,
    value: read(),
  }));
  let current = shown;
  if (shown.entry !== entry) {
    // The entry changed (e.g. navigating to another conversation): React
    // discards this render's output and renders again with the new state
    // before anything commits.
    current = { entry, value: read() };
    setShown(current);
  }
  const value = current.value;
  const latest = useLatestRef(current);

  // A closure made for an earlier entry (a setter, handle or subscription
  // still held after a re-key) acts on its own entry's storage but never
  // restamps what is shown: after a commit the stamp is always the current
  // closures' entry, so a mismatch in an updater can only be a stale closure,
  // and a stamp mismatch in render only a real re-key.

  /** Replace what is shown, only while it is this closure's entry. */
  const showIfCurrent = useCallback(
    (update: (shown: T) => T) =>
      setShown((prev) => {
        if (prev.entry !== entry) return prev;
        const next = update(prev.value);
        return next === prev.value ? prev : { entry, value: next };
      }),
    [entry],
  );

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (action) => {
      const apply = (base: T): T =>
        typeof action === "function"
          ? (action as (prev: T) => T)(base)
          : action;
      if (latest.current.entry !== entry) {
        // A setter from an earlier entry: update that entry's storage once,
        // here — not in an updater, which React may run twice (StrictMode, a
        // rebased update) and which would then build on its own write.
        if (store !== null)
          scheduleDraftWrite(store, apply(read()), { scope: id });
        return;
      }
      setShown((prev) => {
        if (prev.entry !== entry) return prev;
        const next = apply(prev.value);
        if (store !== null) scheduleDraftWrite(store, next, { scope: id });
        return { entry, value: next };
      });
    },
    [store, id, entry, read, latest],
  );

  const clear = useCallback(() => {
    if (store !== null) clearStoredDraft(store, { scope: id });
    showIfCurrent(() => resolvedInitial);
  }, [store, id, resolvedInitial, showIfCurrent]);

  // Sync with other hooks on the same entry (same tab and other tabs). A
  // re-read equal to what is shown keeps the shown value: this hook's own
  // flushed write comes back here parsed from storage, and swapping in that
  // copy would give every array and object in it a new identity on each write
  // (a memo or effect keyed on one would rerun for nothing).
  useEffect(() => {
    if (store === null) return;
    return store.subscribe(id, () => {
      const next = read();
      showIfCurrent((shown) => (same(shown, next) ? shown : next));
    });
  }, [store, id, read, showIfCurrent]);

  const handle = useMemo(
    () =>
      ({
        current: () =>
          latest.current.entry === entry ? latest.current.value : read(),
        flush: () => {
          if (store !== null) flushDraft(store, { scope: id });
        },
        showInitial: () => showIfCurrent(() => resolvedInitial),
        clearIfStill: (sent) => {
          if (store !== null) {
            const stored = readDraft(store, { scope: id });
            if (stored !== null && same(stored, sent))
              clearStoredDraft(store, { scope: id });
          }
          showIfCurrent((shown) =>
            same(shown, sent) ? resolvedInitial : shown,
          );
        },
      }) as KeptHandle<T>,
    [store, id, entry, read, resolvedInitial, latest, showIfCurrent],
  );

  return [value, setValue, clear, handle];
}

const asStored = <T>(stored: unknown): T => stored as T;

/**
 * Drop-in for useState backed by a web-storage store, one entry per scope —
 * in the composition scope this renders in (`useStore`), so a draft typed in
 * an embedded demo is never the page's.
 * All useDraft calls on the same store and scope stay in sync, within the tab
 * and across tabs (the store's subscription covers both).
 *
 * The 4th element is the entry's handle for `submitKept` — the way to clear a
 * draft once what it holds was sent.
 *
 * The reactive wrapper over `draft-storage`. If you are writing at input
 * frequency and do not want a render per write, call `readDraft`/`writeDraft`
 * directly — same store, same entry.
 */
export function useDraft<T>(
  scopedStore: ScopedStore<T> | Store<T>,
  initialValue: T | (() => T),
  options?: { scope?: string },
): KeptBinding<T> {
  const store = useStore(scopedStore) as Store<unknown>;
  return useKeptEntry<T>(
    store,
    options?.scope ?? "",
    initialValue,
    asStored<T>,
  );
}
