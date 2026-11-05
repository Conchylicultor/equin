import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useStore,
  type ScopedStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  clearDraft as clearStoredDraft,
  readDraft,
  writeDraft,
} from "./draft-storage";

function read<T>(store: Store<T>, scope: string | undefined, fallback: T): T {
  return readDraft(store, { scope }) ?? fallback;
}

/**
 * Drop-in for useState backed by a web-storage store, one entry per scope —
 * in the composition scope this renders in (`useStore`), so a draft typed in
 * an embedded demo is never the page's.
 * All useDraft calls on the same store and scope stay in sync, within the tab
 * and across tabs (the store's subscription covers both).
 *
 * The reactive wrapper over `draft-storage`. If you are writing at input
 * frequency and do not want a render per write, call `readDraft`/`writeDraft`
 * directly — same store, same entry.
 */
export function useDraft<T>(
  scopedStore: ScopedStore<T> | Store<T>,
  initialValue: T | (() => T),
  options?: { scope?: string },
): [T, Dispatch<SetStateAction<T>>, () => void] {
  const store = useStore(scopedStore);
  const scope = options?.scope;
  const id = scope ?? "";

  // Resolve initialValue once via useState lazy-init: a stable value (its setter
  // is never called) that can seed the storage read and the effect deps without
  // a render-phase ref read.
  const [resolvedInitial] = useState<T>(() =>
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue,
  );

  const [value, setValueState] = useState<T>(() =>
    read(store, scope, resolvedInitial),
  );

  // Re-read when the entry changes (e.g. navigating to a different conversation).
  const sKey = store.key(id);
  const prevSKeyRef = useRef(sKey);
  useEffect(() => {
    if (prevSKeyRef.current !== sKey) {
      prevSKeyRef.current = sKey;
      setValueState(read(store, scope, resolvedInitial));
    }
  }, [sKey, store, scope, resolvedInitial]);

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (action) => {
      setValueState((prev) => {
        const next =
          typeof action === "function"
            ? (action as (prev: T) => T)(prev)
            : action;
        writeDraft(store, next, { scope });
        return next;
      });
    },
    [store, scope],
  );

  const clear = useCallback(() => {
    clearStoredDraft(store, { scope });
    setValueState(resolvedInitial);
  }, [store, scope, resolvedInitial]);

  // Sync with other useDraft hooks on the same entry (same tab and other tabs).
  useEffect(
    () =>
      store.subscribe(id, () =>
        setValueState(read(store, scope, resolvedInitial)),
      ),
    [store, id, scope, resolvedInitial],
  );

  return [value, setValue, clear];
}
