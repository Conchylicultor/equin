import type { HintOutcome, HintSeen } from "../../core";

/**
 * Where a tip's seen state lives: the rows of the server of the scope that
 * asked for it, and the write that records an answer there. The page's host
 * draws every tip, but a tip asked for inside a `<PluginScope>` (the demo's
 * embedded app, answered by its own worker) must be read and recorded on THAT
 * scope's server — never the page's, or a demo visitor's tip would land in the
 * page user's hints (and the page's would silence the demo's).
 */
export interface SeenLedger {
  /** The scope's seen rows by hint id; `null` while not known (loading, or a failed read). */
  readonly seen: ReadonlyMap<string, HintSeen> | null;
  readonly mark: (id: string, outcome: HintOutcome | null) => void;
}

/**
 * Each scope's ledger, by the moments holding it (every one reads the same
 * server, so any holder's is the scope's) — a scope has a ledger exactly while
 * it has a moment asking, which is when the host needs one. A holder is
 * registered first (`null`) and filled by {@link updateLedger}, so a change of
 * its seen rows replaces the ledger in place: a shown tip never sees its scope
 * without one in between.
 */
const ledgers = new Map<string | null, Map<symbol, SeenLedger | null>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeLedgers(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** `holder` (one asking moment) holds a place in `scope`'s ledger until the returned cleanup. */
export function holdLedger(scope: string | null, holder: symbol): () => void {
  const holders = ledgers.get(scope) ?? new Map<symbol, SeenLedger | null>();
  holders.set(holder, null);
  ledgers.set(scope, holders);
  return () => {
    holders.delete(holder);
    if (holders.size === 0) ledgers.delete(scope);
    notify();
  };
}

/** `holder`'s ledger is now `ledger` (a no-op while it holds no place). */
export function updateLedger(
  scope: string | null,
  holder: symbol,
  ledger: SeenLedger,
): void {
  const holders = ledgers.get(scope);
  if (!holders?.has(holder)) return;
  holders.set(holder, ledger);
  notify();
}

/** `scope`'s ledger, or undefined when no asking moment of it has filled one. */
export function ledgerOf(scope: string | null): SeenLedger | undefined {
  const holders = ledgers.get(scope);
  if (!holders) return undefined;
  let last: SeenLedger | undefined;
  for (const l of holders.values()) if (l) last = l;
  return last;
}
