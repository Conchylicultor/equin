import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
// Relative siblings: this file lives INSIDE the `paths` plugin, so the
// `@plugins/infra/plugins/paths/core` alias would cycle back through the barrel
// that re-exports it. Same reasoning as `data-dir.ts` importing `./paths`.
import type { DataDir } from "./data-dir";
import { worktreeArtifacts, worktreesDir } from "./paths";

// What each namespace on this machine DECLARES under the shared data root.
//
// `~/.singularity/` is host-global: every namespace on the box writes into it,
// so it holds the union of every branch that has ever run here. A checkout's
// `defineDataDir` registry is one branch's view of that root. The two have
// different lifetimes, and comparing them directly is what made
// `paths:no-undeclared-data-dirs` fail a worktree's build on
// `state/agent-write-ledger` — a directory a concurrently-running agent's
// branch had declared correctly and not yet merged (2026-08-30, worktree
// `att-1788099811-aioc`). The failure was unactionable by construction: the
// directory belonged to another live session, so there was nothing safe to
// delete and nothing legitimate to declare.
//
// The repair is to make the RULE as host-global as its subject. Each namespace
// publishes what it declares to its own `worktreeArtifacts.dataDirs(...)`, and
// the audit reads the union — so an entry another live worktree owns is
// recognised as owned rather than reported as an orphan.
//
// See research/2026-09-01-global-host-scoped-data-root-audit.md.

/** Current on-disk format. Bumped when the shape below stops being readable as-is. */
const MANIFEST_VERSION = 1;

/**
 * The two sets an audit compares the real root against — DERIVED from the
 * evaluated registry, never from parsing `data-dirs/index.ts` sources.
 *
 * That distinction is load-bearing: `infra/host/host-admission` builds one
 * `locks/<id>` declaration per entry of `HOST_POOLS`, so a declared name is
 * not always a literal that appears anywhere in the file. A source-scanning
 * reader would miss exactly those and report them as orphans.
 */
export interface DeclaredSets {
  /** `${kind}/${name}` — what the second-level (inside a kind directory) rule compares against. */
  keys: string[];
  /**
   * First path segment of every declaration carrying a `legacyLocation` — what
   * the top-level rule compares against. The FIRST segment only: a legacy path
   * may reach deeper than the root's own listing, and what such a declaration
   * clears is exactly one top-level entry.
   */
  rootEntries: string[];
}

export interface DataDirsManifest extends DeclaredSets {
  version: number;
  namespace: string;
  writtenAt: string;
}

/**
 * The two sets, from the registry. ONE derivation, shared by the writer that
 * publishes a namespace's manifest and by the audit computing its own local
 * sets — so what a checkout publishes and what it checks itself against cannot
 * drift into two different answers.
 */
export function declaredSets(
  declared: ReadonlyMap<string, DataDir>,
): DeclaredSets {
  const rootEntries = new Set<string>();
  for (const dir of declared.values()) {
    const legacy = dir.spec.legacyLocation;
    if (legacy) rootEntries.add(legacy.path.split("/")[0]!);
  }
  return {
    keys: [...declared.keys()].sort(),
    rootEntries: [...rootEntries].sort(),
  };
}

/**
 * Publish this namespace's declared set, atomically (write a sibling temp file,
 * then rename). A reader in another checkout must never observe a half-written
 * manifest — it would attribute fewer entries than the namespace really owns,
 * i.e. report another agent's live directory as an orphan, which is the exact
 * failure this file exists to end.
 */
export function writeDataDirsManifest(
  namespace: Namespace,
  sets: DeclaredSets,
): string {
  const path = worktreeArtifacts.dataDirs(namespace);
  const manifest: DataDirsManifest = {
    version: MANIFEST_VERSION,
    namespace,
    writtenAt: new Date().toISOString(),
    ...sets,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** A manifest that could not be read, and why — never silently skipped. */
export interface UnreadableManifest {
  namespace: string;
  reason: string;
}

export interface ForeignManifests {
  manifests: DataDirsManifest[];
  /**
   * Namespaces whose manifest exists but could not be used. Reported by the
   * audit rather than swallowed: a namespace that publishes garbage attributes
   * nothing, so its live directories would surface as orphans, and the reason
   * for that has to be visible somewhere.
   */
  unreadable: UnreadableManifest[];
}

/**
 * Every namespace's manifest that EXISTS, as `${namespace}:${mtimeMs}:${size}` —
 * a stat, never a parse, because this runs on every check including the ones
 * that hit the cache.
 *
 * For the audit's `cacheSignature()`. Folding these in is what stops a PASS
 * recorded while another checkout excused an entry from outliving that
 * checkout's removal: the root listing does not change when a namespace goes
 * away, so without this the verdict would replay green over a directory that
 * has since become a real orphan.
 *
 * Unlike {@link readForeignManifests} this takes no `self` and excludes
 * nothing. A signature may cover MORE than the verdict reads — that only costs
 * a re-run — and taking no self is what keeps it callable from a synchronous
 * `cacheSignature()`, which has no worktree root to derive one from.
 */
export function manifestStamps(): string[] {
  const stamps: string[] = [];
  for (const name of listNamespaces()) {
    const st = statManifest(worktreeArtifacts.dataDirs(asNamespace(name)));
    if (st) stamps.push(`${name}:${st.mtimeMs}:${st.size}`);
  }
  return stamps;
}

/**
 * Namespaces with a data dir on this machine, sorted.
 *
 * DIRECTORIES only, and that is not belt-and-braces. The worktrees dir also
 * holds loose registry FILES beside the namespace dirs (`central.json`,
 * `<main namespace>.json`, …), and `isNamespace` says yes to those — `central.json`
 * is a perfectly legal two-label namespace name. Filtering by name alone
 * therefore asked for `central.json/data-dirs.json`, which fails with ENOTDIR,
 * and `throwIfNoEntry: false` suppresses only ENOENT — so the audit threw
 * instead of running.
 */
function listNamespaces(): string[] {
  let entries;
  try {
    entries = readdirSync(worktreesDir(), { withFileTypes: true });
  } catch (err) {
    // A machine that has never run a build has no worktrees dir at all. Any
    // other failure is a real fault and rethrows.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && isNamespace(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * `stat` a manifest, or `undefined` when there is no file to read there.
 *
 * ENOTDIR is folded in with ENOENT deliberately: both answer the only question
 * being asked — "is there a manifest at this path" — with no. A symlinked
 * namespace dir pointing at a file would otherwise crash the whole audit over
 * one namespace's oddity.
 */
function statManifest(path: string): ReturnType<typeof statSync> | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? st : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function parseManifest(raw: string): DataDirsManifest | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return `not JSON (${(err as Error).message})`;
  }
  if (typeof value !== "object" || value === null) return "not an object";
  const m = value as Partial<DataDirsManifest>;
  if (m.version !== MANIFEST_VERSION)
    return `version ${String(m.version)}, expected ${MANIFEST_VERSION}`;
  if (typeof m.namespace !== "string") return "no namespace";
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  if (!isStrings(m.keys)) return "keys is not a string[]";
  if (!isStrings(m.rootEntries)) return "rootEntries is not a string[]";
  return {
    version: m.version,
    namespace: m.namespace,
    writtenAt: typeof m.writtenAt === "string" ? m.writtenAt : "",
    keys: m.keys,
    rootEntries: m.rootEntries,
  };
}

/**
 * Every OTHER namespace's manifest on this machine.
 *
 * `self` is excluded because the audit already holds its own registry in
 * memory — reading it back off disk would let a stale manifest excuse an entry
 * the running checkout no longer declares, turning this checkout's own orphan
 * into someone else's problem.
 *
 * A namespace with no manifest contributes nothing and is not an error: it has
 * not booted since manifests existed, or never boots at all. The cost is an
 * unattributed entry, which reads as an ordinary undeclared one.
 */
export function readForeignManifests(self: string): ForeignManifests {
  const manifests: DataDirsManifest[] = [];
  const unreadable: UnreadableManifest[] = [];

  for (const name of listNamespaces()) {
    if (name === self) continue;
    const path = worktreeArtifacts.dataDirs(asNamespace(name));
    if (!statManifest(path)) continue;
    const parsed = parseManifest(readFileSync(path, "utf8"));
    if (typeof parsed === "string") {
      unreadable.push({ namespace: name, reason: parsed });
      continue;
    }
    manifests.push(parsed);
  }
  return { manifests, unreadable };
}

/** Which namespaces declare each of `names`, for the names any of them declares. */
function attributeAgainst(
  names: readonly string[],
  manifests: readonly DataDirsManifest[],
  pick: (m: DataDirsManifest) => readonly string[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const manifest of manifests) {
    const declared = new Set(pick(manifest));
    for (const name of names) {
      if (!declared.has(name)) continue;
      const list = owners.get(name);
      if (list) list.push(manifest.namespace);
      else owners.set(name, [manifest.namespace]);
    }
  }
  return owners;
}

/**
 * Split candidate offenders into the ones another live namespace declares and
 * the ones nobody does.
 *
 * Pure, and the whole of the new decision — so the rule can be tested without a
 * real data root under it.
 */
export function partitionByOwner(
  candidates: readonly string[],
  manifests: readonly DataDirsManifest[],
  which: "keys" | "rootEntries",
): { orphans: string[]; attributed: Map<string, string[]> } {
  const attributed = attributeAgainst(candidates, manifests, (m) =>
    which === "keys" ? m.keys : m.rootEntries,
  );
  return {
    orphans: candidates.filter((c) => !attributed.has(c)),
    attributed,
  };
}

/** `state/x (att-1, att-2)` — one attributed entry, as a person reads it. */
export function describeAttribution(
  attributed: ReadonlyMap<string, string[]>,
): string {
  return [...attributed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, owners]) => `${name} (${[...owners].sort().join(", ")})`)
    .join(", ");
}
