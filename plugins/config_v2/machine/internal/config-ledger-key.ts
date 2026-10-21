/**
 * How a config document is named in the shared agent-write ledger
 * (`@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server`).
 *
 * The ledger keys an entry by one opaque string and prints it to the e2e
 * harness as `Config documents: <key>`, so the key is the readable
 * `<storePath>` for the base scope and `<storePath> @<scopeId>` for a scoped
 * document — the spelling the harness used before the ledger was shared. The
 * restore reads (storePath, scopeId) back out of it, so the encoding must be
 * injective: {@link configLedgerKey} refuses the one input that would make it
 * ambiguous, rather than trusting that no store path ever contains the mark.
 */

const SCOPE_MARK = " @";

/** `""` is the base scope. */
export function configLedgerKey(storePath: string, scopeId: string): string {
  if (storePath.includes(SCOPE_MARK) || scopeId.includes(SCOPE_MARK)) {
    throw new Error(
      `[config-v2] cannot name ${JSON.stringify(storePath)} @ ${JSON.stringify(scopeId)} in the agent-write ledger: ` +
        `"${SCOPE_MARK}" separates the store path from the scope id, so neither may contain it.`,
    );
  }
  return scopeId ? `${storePath}${SCOPE_MARK}${scopeId}` : storePath;
}

/** Inverse of {@link configLedgerKey}. */
export function configLedgerDocument(key: string): {
  storePath: string;
  scopeId: string;
} {
  const at = key.lastIndexOf(SCOPE_MARK);
  if (at < 0) return { storePath: key, scopeId: "" };
  return {
    storePath: key.slice(0, at),
    scopeId: key.slice(at + SCOPE_MARK.length),
  };
}
