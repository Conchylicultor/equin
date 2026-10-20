/**
 * The render-free half of persistent-draft over a web-storage `Store`: read,
 * write and clear one draft, and announce every write and clear to the tab.
 *
 * `useDraft` is a `useState` drop-in, so every write re-renders its subscribers.
 * That is right for a text draft and wrong for anything written at input
 * frequency (a scroll offset, a cursor position): those callers want the same
 * store without a render per write. Both halves share this file — `useDraft`
 * is the reactive wrapper over these functions.
 *
 * The store owns the key grammar, envelope, TTL and cap, and makes a refused
 * write loud (a toast, a report, the health row). A draft's owner declares it
 * with `defineStore` (whenFull: "refuse" for what the user typed).
 */

import type {
  LegacyKeys,
  Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

const DRAFT_SYNC_EVENT = "singularity:draft-updated";
export const DEFAULT_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * One write or clear of a draft, as `onDraftWritten` hands it out. `value` is
 * `undefined` for a clear; `ttl` is the draft's own (`Infinity`: never expires).
 */
export interface DraftWrite {
  storageKey: string;
  value: unknown;
  ttl: number;
}

function announce(write: DraftWrite): void {
  window.dispatchEvent(new CustomEvent(DRAFT_SYNC_EVENT, { detail: write }));
}

/**
 * Observe every draft written or cleared in this tab — for state that must
 * live exactly as long as a draft (the attachments it references). Returns the
 * unsubscribe.
 */
export function onDraftWritten(
  listener: (write: DraftWrite) => void,
): () => void {
  const handle = (e: Event) => listener((e as CustomEvent<DraftWrite>).detail);
  window.addEventListener(DRAFT_SYNC_EVENT, handle);
  return () => window.removeEventListener(DRAFT_SYNC_EVENT, handle);
}

export interface DraftOptions {
  /** The entity the draft belongs to (a conversation id); one entry per scope. */
  scope?: string;
}

/**
 * The stored draft, or `null` when there is nothing to restore.
 *
 * `null` covers absent, expired, unreadable and unavailable alike — for a
 * draft all four mean "no draft to restore", the state a first visit produces.
 * Unreadable is not silent: the store dropped the entry and reported it.
 */
export function readDraft<T>(
  store: Store<T>,
  options?: DraftOptions,
): T | null {
  const read = store.read(options?.scope ?? "");
  return read.kind === "value" ? read.value : null;
}

/**
 * Persist a draft. A refused write (over the store's cap, or the browser's)
 * keeps the value only in memory — the store announces it loudly, and the
 * surface the user is typing into keeps working.
 */
export function writeDraft<T>(
  store: Store<T>,
  value: T,
  options?: DraftOptions,
): void {
  const id = options?.scope ?? "";
  const written = store.write(id, value);
  if (written.ok)
    announce({ storageKey: store.key(id), value, ttl: store.ttl });
}

export function clearDraft<T>(store: Store<T>, options?: DraftOptions): void {
  const id = options?.scope ?? "";
  store.remove(id);
  announce({ storageKey: store.key(id), value: undefined, ttl: store.ttl });
}

/**
 * The `legacy` of a store taking over drafts persistent-draft wrote before
 * web-storage (`singularity:draft:<key>[:<scope>]`, envelope `{v, ts}`): each
 * old entry is carried over under its scope, so no unsent text is lost.
 */
export function legacyDraftKeys(key: string): LegacyKeys {
  const exact = `singularity:draft:${key}`;
  const scoped = `${exact}:`;
  return {
    match: (k) => k === exact || k.startsWith(scoped),
    adopt(k, raw) {
      let env: unknown;
      try {
        env = JSON.parse(raw);
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw err;
      }
      if (
        typeof env !== "object" ||
        env === null ||
        !("v" in env) ||
        !("ts" in env) ||
        typeof env.ts !== "number"
      )
        return null;
      return {
        id: k === exact ? "" : k.slice(scoped.length),
        value: env.v,
        ts: env.ts,
      };
    },
  };
}
