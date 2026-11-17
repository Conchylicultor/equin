import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

/** How a stored value is read back: as is (a store's own schema), or reparsed. */
type Parse<T> = (stored: unknown) => T | null;

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

  const [value, setValueState] = useState<T>(read);
  const latest = useLatestRef(value);

  // Re-read when the entry changes (e.g. navigating to a different conversation).
  const sKey = store === null ? null : store.key(id);
  const prevSKeyRef = useRef(sKey);
  useEffect(() => {
    if (prevSKeyRef.current !== sKey) {
      prevSKeyRef.current = sKey;
      setValueState(read());
    }
  }, [sKey, read]);

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (action) => {
      setValueState((prev) => {
        const next =
          typeof action === "function"
            ? (action as (prev: T) => T)(prev)
            : action;
        if (store !== null) scheduleDraftWrite(store, next, { scope: id });
        return next;
      });
    },
    [store, id],
  );

  const clear = useCallback(() => {
    if (store !== null) clearStoredDraft(store, { scope: id });
    setValueState(resolvedInitial);
  }, [store, id, resolvedInitial]);

  // Sync with other hooks on the same entry (same tab and other tabs).
  useEffect(() => {
    if (store === null) return;
    return store.subscribe(id, () => setValueState(read()));
  }, [store, id, read]);

  const handle = useMemo(
    () =>
      ({
      current: () => latest.current,
      flush: () => {
        if (store !== null) flushDraft(store, { scope: id });
      },
      showInitial: () => setValueState(resolvedInitial),
      clearIfStill: (sent) => {
        if (store !== null) {
          const stored = readDraft(store, { scope: id });
          if (stored !== null && same(stored, sent))
            clearStoredDraft(store, { scope: id });
        }
        setValueState((shown) => (same(shown, sent) ? resolvedInitial : shown));
      },
      }) as KeptHandle<T>,
    [store, id, resolvedInitial, latest],
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
