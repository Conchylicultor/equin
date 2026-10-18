// The contract-refs store: per (file, signature), the specifiers its emitted
// `.d.ts` names (`./contract-refs.ts`).
//
// Why a store: tsc's incremental emit produces the `.d.ts` of only the files it
// re-checked, but the type fingerprint needs every source file's contract edges
// on every run. A signature is the hash of the `.d.ts` text, so what that text
// names is a fact of (file, signature) — recorded once, host-wide, by whichever
// run emitted it, and read by every later run whose buildinfo carries the same
// signature. The worker fills a miss by emitting that one file's declaration.
//
// Specifiers, never resolved paths: resolution depends on the tree around the
// file (a new file can shadow `./x`), so it is redone on every run.

import {
  contractSpecifiersSchema,
  type ContractRefsLookup,
} from "./contract-refs";
import { openPassSet, type PassSetBounds } from "./pass-set";
import { contractRefsDir } from "../data-dirs";

// One entry per (file, API version), a few hundred bytes each. Bounded like the
// lint result store, which holds one per (file, text) — always at least as many.
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 200000,
  trimTo: 160000,
  pruneIntervalMs: 60 * 60 * 1000,
};

/** Open (and lazily create) the host-global contract-refs store. */
export function openContractRefsStore(): ContractRefsLookup {
  const set = openPassSet(contractRefsDir, BOUNDS);
  const key = (relPath: string, signature: string): string =>
    `${relPath}\0${signature}`;
  return {
    read(relPath, signature) {
      const raw = set.read(key(relPath, signature));
      // Written by `record` below and renamed into place whole: a shape this
      // schema rejects is a bug in this file, surfaced.
      return raw === undefined
        ? undefined
        : contractSpecifiersSchema.parse(raw);
    },
    record(relPath, signature, refs) {
      set.record(key(relPath, signature), { ...refs });
    },
  };
}
