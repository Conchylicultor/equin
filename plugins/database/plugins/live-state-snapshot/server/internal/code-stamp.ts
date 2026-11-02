import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

// The code stamp of an L2 definition. A persisted value is served back only
// under an equal definition (the usable-row predicate), and a definition pins
// the compiled SQL, decoders and row schema — not the CODE that turned them
// into the stored value (the compilers, decoders, the `$columns` fold:
// query-resource's `liveReadCode`). So every definition L2 writes or expects
// is stamped with that code's digest: a row persisted by other code no longer
// matches and is recomputed, with no version constant to bump.
//
// The digest needs the source on disk, so the desktop half (`../machine`)
// provides it as a contribution — collected before any `onReadyBlocking`, so
// this portable half reads it whatever order the halves boot in. A host with
// none (a browser host's in-memory database) stamps with a value of its own
// process: nothing persisted by another process is ever usable there, which
// costs nothing on a database that does not outlive the process and stays
// correct on one that would.
export const L2CodeStamp = defineServerContribution<{
  /** The digest of the code that shapes persisted values (rejects ⇒ L2 is off). */
  stamp: () => Promise<string>;
}>("live-state-snapshot-code-stamp", { docLabel: () => "liveReadCode digest" });

type Stamp = { kind: "pending" } | { kind: "known"; value: string };

let stamp: Stamp = { kind: "pending" };

// What a definition reads before the stamp is known (a degraded init, which
// installs no persist hook): no stored row carries it — every one written was
// stamped — so nothing matches, and nothing is served.
const UNSTAMPED = "unstamped";

/**
 * Resolve this process's stamp (the L2 init, before its persist hooks are
 * installed). Throws when the provider's digest fails or two plugins provide
 * one: the caller degrades L2 to off — nothing is persisted or served.
 */
export async function resolveCodeStamp(
  providers: readonly {
    stamp: () => Promise<string>;
  }[] = L2CodeStamp.getContributions(),
): Promise<void> {
  if (providers.length > 1) {
    throw new Error(
      `[live-state-snapshot] ${providers.length} plugins provide the L2 code stamp — exactly one may`,
    );
  }
  const provider = providers[0];
  stamp = {
    kind: "known",
    value:
      provider === undefined
        ? `process:${crypto.randomUUID()}`
        : `code:${await provider.stamp()}`,
  };
}

/** A definition as L2 stores and expects it: stamped with this process's code. */
export function stampDefinition(definition: string | null): string | null {
  if (definition === null) return null;
  if (stamp.kind === "pending") return UNSTAMPED;
  return sha256Hex(`${stamp.value}\u0000${definition}`);
}

/** Test seam: back to the boot state. */
export function resetCodeStamp(): void {
  stamp = { kind: "pending" };
}
