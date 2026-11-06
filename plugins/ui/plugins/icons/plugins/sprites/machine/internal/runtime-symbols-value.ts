import { serveValue } from "@plugins/network/plugins/live/machine";
import { isStyleKey } from "@plugins/ui/plugins/icons/core";
import { isSavedSymbolName } from "@plugins/ui/plugins/icons/plugins/saved-names/core";
import { MAX_RUNTIME_SYMBOLS_PER_READ, runtimeSymbolsValue } from "../../core";
import { runtimeSymbols, symbolsHash } from "./runtime-symbols";

/**
 * Saved (runtime) symbols in one style, for `<Icon>` on a name the resident
 * saved-icon sprites do not carry in that style (a picker grid, a history
 * preview, a themed scope). Content-addressed: `names` must be ONE spelling of
 * its set (sorted, duplicate-free — two spellings of one set would be two
 * tuples), and `hash` must be this process's sets hash.
 */
export async function loadRuntimeSymbols({
  hash,
  key,
  names: raw,
}: {
  hash: string;
  key: string;
  names: string;
}): Promise<string> {
  if (!isStyleKey(key)) {
    throw runtimeSymbolsValue.refuse(
      "unknown-key",
      `No style key is named "${key}"`,
    );
  }
  if (hash !== symbolsHash) {
    throw runtimeSymbolsValue.refuse(
      "stale-symbols",
      `Symbols version ${hash} is not this server's (${symbolsHash}); reload the page`,
    );
  }
  const names = raw === "" ? [] : raw.split(",");
  if (names.length === 0 || names.length > MAX_RUNTIME_SYMBOLS_PER_READ) {
    throw runtimeSymbolsValue.refuse(
      "invalid-names",
      `names must hold 1 to ${MAX_RUNTIME_SYMBOLS_PER_READ} names (got ${names.length})`,
    );
  }
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1]! >= names[i]!) {
      throw runtimeSymbolsValue.refuse(
        "invalid-names",
        "names must be sorted and duplicate-free",
      );
    }
  }
  const unknown = names.filter((n) => !isSavedSymbolName(n));
  if (unknown.length > 0) {
    throw runtimeSymbolsValue.refuse(
      "unknown-name",
      `Unknown symbol name(s): ${unknown.join(", ")}`,
    );
  }
  return await runtimeSymbols(key, names);
}

/**
 * External and `immutable`: this process answers only its own sets hash, and
 * a tuple's symbols are a pure function of those sets (`runtimeSymbols` keeps
 * each style's map once built). Its ETag is the tuple itself while `hash` is
 * this process's — so a tab replaying it after a restart that kept the sets
 * is answered `up-to-date` instead of re-sent — and a value no stored ETag
 * can equal otherwise (that tuple is refused `stale-symbols`).
 */
export const runtimeSymbolsServed = serveValue(runtimeSymbolsValue, {
  source: "external",
  // A pick from `runtimeSymbols`' per-style map, built once per process.
  readCost: "memory",
  changes: {
    immutable: {
      reason:
        "content-addressed by symbolsHash (the sets, the saved-name list, the symbol build version) and the sorted names",
    },
  },
  revalidate: ({ hash, key, names }) =>
    Promise.resolve(
      hash === symbolsHash
        ? `${hash}/${key}/${names}`
        : `stale-symbols/${symbolsHash}`,
    ),
  loader: loadRuntimeSymbols,
});
