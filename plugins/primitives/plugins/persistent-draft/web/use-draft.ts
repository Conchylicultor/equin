import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clearDraft as clearStoredDraft,
  DEFAULT_DRAFT_TTL,
  draftKey,
  onDraftWritten,
  readDraft,
  writeDraft,
} from "./draft-storage";

function read<T>(key: string, scope: string | undefined, fallback: T, ttl: number): T {
  return readDraft<T>(key, { scope, ttl }) ?? fallback;
}

/**
 * Drop-in for useState backed by localStorage with optional entity scope and TTL.
 * All useDraft calls sharing the same resolved key stay in sync within the tab
 * via a custom window event, and across tabs via the native storage event.
 *
 * The reactive wrapper over `draft-storage`. If you are writing at input
 * frequency and do not want a render per write, call `readDraft`/`writeDraft`
 * directly — same key grammar, same envelope, same sync event.
 */
export function useDraft<T>(
  key: string,
  initialValue: T | (() => T),
  options?: { scope?: string; ttl?: number },
): [T, Dispatch<SetStateAction<T>>, () => void] {
  const scope = options?.scope;
  const ttl = options?.ttl ?? DEFAULT_DRAFT_TTL;
  const sKey = draftKey(key, scope);

  // Resolve initialValue once via useState lazy-init: a stable value (its setter
  // is never called) that can seed the storage read and the effect deps without
  // a render-phase ref read.
  const [resolvedInitial] = useState<T>(() =>
    typeof initialValue === "function"
      ? (initialValue as () => T)()
      : initialValue,
  );

  const [value, setValueState] = useState<T>(() =>
    read(key, scope, resolvedInitial, ttl),
  );

  // Re-read when sKey changes (e.g. navigating to a different conversation).
  const prevSKeyRef = useRef(sKey);
  useEffect(() => {
    if (prevSKeyRef.current !== sKey) {
      prevSKeyRef.current = sKey;
      setValueState(read(key, scope, resolvedInitial, ttl));
    }
  }, [sKey, key, scope, resolvedInitial, ttl]);

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (action) => {
      setValueState((prev) => {
        const next =
          typeof action === "function"
            ? (action as (prev: T) => T)(prev)
            : action;
        writeDraft(key, next, { scope, ttl });
        return next;
      });
    },
    [key, scope, ttl],
  );

  const clear = useCallback(() => {
    clearStoredDraft(key, { scope, ttl });
    setValueState(resolvedInitial);
  }, [key, scope, ttl, resolvedInitial]);

  // Sync with other useDraft hooks on the same key (same-tab and cross-tab).
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === sKey) {
        setValueState(read(key, scope, resolvedInitial, ttl));
      }
    };
    const unsubscribe = onDraftWritten((write) => {
      if (write.storageKey === sKey) {
        setValueState(read(key, scope, resolvedInitial, ttl));
      }
    });
    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", handleStorage);
    };
  }, [sKey, key, scope, resolvedInitial, ttl]);

  return [value, setValue, clear];
}
