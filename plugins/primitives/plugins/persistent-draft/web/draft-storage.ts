/**
 * The storage half of persistent-draft: key grammar, TTL envelope, and the
 * same-tab/cross-tab sync event — with no React attached.
 *
 * `useDraft` is a `useState` drop-in, so every write re-renders its subscribers.
 * That is right for a text draft and wrong for anything written at input
 * frequency (a scroll offset, a cursor position): those callers want the same
 * envelope, TTL and key grammar without a render per write. Rather than let them
 * hand-roll a second copy of this file, both halves share it — `useDraft` is now
 * the reactive wrapper over these functions.
 */

export const DRAFT_SYNC_EVENT = "singularity:draft-updated";
export const DEFAULT_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

type Envelope<T> = { v: T; ts: number };

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
  scope?: string;
  ttl?: number;
  /**
   * Where the value lives: `local` (the default) outlives the tab and is shared
   * by every tab of the origin; `session` is this browser tab's own — it
   * survives a reload and dies with the tab, and no other tab sees it.
   */
  storage?: "local" | "session";
}

function storageOf(options?: DraftOptions): Storage {
  return options?.storage === "session" ? sessionStorage : localStorage;
}

export function draftKey(key: string, scope?: string): string {
  return scope
    ? `singularity:draft:${key}:${scope}`
    : `singularity:draft:${key}`;
}

/**
 * Read a stored value, or `null` when there is nothing usable to read.
 *
 * `null` covers absent, TTL-expired and unparseable alike — and that is a
 * legitimate empty success rather than an absorbed failure: for a draft, all
 * three mean "no draft to restore", the exact state a first visit produces, and
 * every caller already has to handle it. Callers needing to distinguish "saved
 * but no longer resolvable" must do so against their own domain (see
 * `auto-scroll`'s `resolveRestore`, which separates `none` from `missing`).
 */
export function readDraft<T>(key: string, options?: DraftOptions): T | null {
  const sKey = draftKey(key, options?.scope);
  const ttl = options?.ttl ?? DEFAULT_DRAFT_TTL;
  try {
    const store = storageOf(options);
    const raw = store.getItem(sKey);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as Envelope<T>;
    if (Date.now() - envelope.ts > ttl) {
      store.removeItem(sKey);
      return null;
    }
    return envelope.v;
  } catch (err) {
    // A DOMException means storage is unavailable (private mode / blocked) — an
    // environment condition. A SyntaxError means our own bytes are unreadable.
    // Neither has a recovery path better than "no draft"; anything else is a
    // real bug and must not be swallowed.
    if (err instanceof SyntaxError || err instanceof DOMException) return null;
    throw err;
  }
}

export function writeDraft<T>(
  key: string,
  value: T,
  options?: DraftOptions,
): void {
  const sKey = draftKey(key, options?.scope);
  try {
    const envelope: Envelope<T> = { v: value, ts: Date.now() };
    storageOf(options).setItem(sKey, JSON.stringify(envelope));
    announce({
      storageKey: sKey,
      value,
      ttl: options?.ttl ?? DEFAULT_DRAFT_TTL,
    });
  } catch (err) {
    // Quota exhaustion and blocked storage are the two expected failures, and a
    // draft that cannot be persisted must never break the surface the user is
    // typing into — but it must not go unnoticed either: the user keeps typing
    // into an editor that looks saved and loses it all on reload. Anything else
    // rethrows.
    if (err instanceof DOMException) {
      announceFailure(err);
      return;
    }
    throw err;
  }
}

const DRAFT_FAILED_EVENT = "singularity:draft-write-failed";

function announceFailure(err: DOMException): void {
  window.dispatchEvent(new CustomEvent(DRAFT_FAILED_EVENT, { detail: err }));
}

/**
 * Observe every draft write the browser refused (storage full or blocked) — the
 * draft stayed only in memory and is lost on reload, so the user must be told.
 * Returns the unsubscribe.
 */
export function onDraftWriteFailed(
  listener: (err: DOMException) => void,
): () => void {
  const handle = (e: Event) =>
    listener((e as CustomEvent<DOMException>).detail);
  window.addEventListener(DRAFT_FAILED_EVENT, handle);
  return () => window.removeEventListener(DRAFT_FAILED_EVENT, handle);
}

export function clearDraft(key: string, options?: DraftOptions): void {
  const sKey = draftKey(key, options?.scope);
  try {
    storageOf(options).removeItem(sKey);
    announce({
      storageKey: sKey,
      value: undefined,
      ttl: options?.ttl ?? DEFAULT_DRAFT_TTL,
    });
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
}
