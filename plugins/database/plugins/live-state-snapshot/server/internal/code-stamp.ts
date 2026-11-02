import {
  defineServerContribution,
  Resource,
  type PersistedCode,
} from "@plugins/framework/plugins/server-core/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

// The code stamp of every persisted key. A persisted value is served back only
// under an equal stored definition (the usable-row predicate), and a
// definition — when a key has one — pins the compiled SQL, decoders and row
// schema, never the CODE that turned them into the stored value (a compiler,
// a hand-written loader). So each key's stored definition is
// `sha256(stamp ‖ definition)`, the stamp being the digest of the code its
// `Resource.Declare` names (`code`: an `all` collection's `liveReadCode`, a
// preloaded db `serveValue`'s own module): a row persisted by other code no
// longer matches and is recomputed, with no version constant to bump — and a
// key without a definition (a hand-written loader) is versioned by its code
// alone instead of never.
//
// Failing closed: a key is persisted only once its stamp is known
// (`shouldPersist`). A Declare naming no `code`, or whose digest fails, is
// never persisted, written or served — a value with no code version has no
// row to go stale.
//
// The digest needs the source on disk, so the desktop half (`../machine`)
// provides it as a contribution — collected before any `onReadyBlocking`, so
// this portable half reads it whatever order the halves boot in. A host with
// none (a browser host's in-memory database) stamps every key with a value of
// its own process: nothing persisted by another process is ever usable there,
// which costs nothing on a database that does not outlive the process and
// stays correct on one that would.
export const L2CodeDigest = defineServerContribution<{
  /** The digest of the code `code` loads (rejects ⇒ the keys it stamps are not persisted). */
  digest: (code: readonly PersistedCode[]) => Promise<string>;
}>("live-state-snapshot-code-digest", { docLabel: () => "sourceDigest" });

type Stamps =
  { kind: "pending" } | { kind: "known"; byKey: ReadonlyMap<string, string> };

let stamps: Stamps = { kind: "pending" };

// What a definition reads before the stamps are known (a degraded init, which
// installs no persist hook) or for a key without one: no stored row carries
// it — every row written was stamped — so nothing matches, and nothing is
// served.
const UNSTAMPED = "unstamped";

/**
 * The keys L2 may persist, each with the code that produces its value: a
 * preloaded key (one param-less tuple — an ENUMERATED preload, whose Declare
 * carries `preloadTuples`, has N) whose Declare names its `code`. Read
 * generically from the Declare set (never by resource name). The runtime adds
 * the rest of the gate (never an external or bounded entry).
 */
export function persistCandidates(
  declares: readonly {
    key: string;
    preload?: unknown;
    preloadTuples?: unknown;
    code?: readonly PersistedCode[];
  }[] = Resource.Declare.getContributions(),
): ReadonlyMap<string, readonly PersistedCode[]> {
  const out = new Map<string, readonly PersistedCode[]>();
  for (const d of declares) {
    if (d.preload === undefined || d.preloadTuples !== undefined) continue;
    if (d.code === undefined || d.code.length === 0) continue;
    out.set(d.key, d.code);
  }
  return out;
}

/**
 * Resolve every candidate key's stamp (the L2 init, before its persist hooks
 * are installed). A key whose digest fails is left out — not persisted this
 * boot — and handed to `failed`; the others are stamped. Throws when two
 * plugins provide a digest: the caller degrades L2 to off.
 */
export async function resolveCodeStamps(
  failed: (key: string, err: unknown) => void,
  candidates: ReadonlyMap<
    string,
    readonly PersistedCode[]
  > = persistCandidates(),
  providers: readonly {
    digest: (code: readonly PersistedCode[]) => Promise<string>;
  }[] = L2CodeDigest.getContributions(),
): Promise<void> {
  if (providers.length > 1) {
    throw new Error(
      `[live-state-snapshot] ${providers.length} plugins provide the L2 code digest — exactly one may`,
    );
  }
  const provider = providers[0];
  const processStamp = `process:${crypto.randomUUID()}`;
  const byKey = new Map<string, string>();
  await Promise.all(
    [...candidates].map(async ([key, code]) => {
      if (provider === undefined) {
        byKey.set(key, processStamp);
        return;
      }
      try {
        byKey.set(key, `code:${await provider.digest(code)}`);
      } catch (err) {
        failed(key, err);
      }
    }),
  );
  stamps = { kind: "known", byKey };
}

/** The persist gate: a candidate key whose code stamp is known. */
export function shouldPersist(key: string): boolean {
  return stamps.kind === "known" && stamps.byKey.has(key);
}

/**
 * A key's definition as L2 stores and expects it: stamped with the code that
 * produces its value — never NULL, so a key without a definition of its own
 * is versioned by its code.
 */
export function stampDefinition(
  key: string,
  definition: string | null,
): string {
  const stamp = stamps.kind === "known" ? stamps.byKey.get(key) : undefined;
  if (stamp === undefined) return UNSTAMPED;
  return sha256Hex(`${stamp}\u0000${definition ?? "\u0001none"}`);
}

/** Test seam: back to the boot state. */
export function resetCodeStamps(): void {
  stamps = { kind: "pending" };
}
