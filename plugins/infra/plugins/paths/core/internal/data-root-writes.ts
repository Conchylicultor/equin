import { DATA_DIR_KINDS } from "./data-dir";
import {
  readForeignManifestsSync,
  readMainManifestSync,
} from "./data-dirs-manifest";
import { legacyRootEntries } from "./legacy-layout";

/**
 * Kinds whose CONTENTS are not a declared set: nothing names their children,
 * so neither `paths:no-undeclared-data-dirs`' second-level rule nor
 * {@link dataRootWriteViolationSync} asks for one.
 *
 * - `deprecated` IS the quarantine: its entries are precisely the things with no
 *   owner, so demanding a declaration for each would invert the point of it.
 * - `worktrees` is per-worktree and dynamic — one entry per live namespace,
 *   minted and reaped at runtime. Its layout is owned by `paths.ts`
 *   (`worktreeDataDir` / `worktreeArtifacts`) and policed by
 *   `paths:no-inlined-worktree-artifacts`, not by a registry of names.
 */
export const OPEN_KINDS: ReadonlySet<string> = new Set([
  "deprecated",
  "worktrees",
]);

/** A write by hand that would put something at the data root nothing declares. */
export type DataRootWriteViolation =
  /** `<root>/<entry>`: a top-level name that is neither a kind nor a legacy shim. */
  | { kind: "root-entry"; entry: string }
  /** `<root>/<kind>/<name>` that does not exist yet: a new data dir, minted by hand. */
  | { kind: "kind-child"; entry: string };

/**
 * Would writing `path` by hand mint an entry at the data root that nothing
 * declares? The question `paths:no-undeclared-data-dirs` asks of the root
 * AFTER the fact (hourly, as a `host-check` report), asked of one write BEFORE
 * it lands — for the agent guard that refuses it (`guards`' data-root-writes).
 *
 * A data dir comes into existence one way: its declaration's `ensure()`, from
 * code. So a write by hand may land only INSIDE what already stands:
 *
 * - top level: a kind directory, a legacy name the table keeps as the
 *   compatibility link to its declared target (`prototypes` →
 *   `apps/prototypes`), or a service a declaration grandfathers where it
 *   already sits (`postgres`, `sockets` — `declaredRootEntriesSync`, read only when
 *   the first two do not answer). Anything else — a fresh `demo-audit-…/`, a
 *   loose `tmp-probe-….png` — is an undeclared entry the audit fails on.
 * - second level: a `<kind>/<name>` that already exists (declared dirs exist
 *   once their owner has run). One that does not would be a new data dir with
 *   no declaration. The {@link OPEN_KINDS} take any child.
 *
 * Pure apart from what `root` reads, so it is tested without a real root.
 * `roots` are every spelling of THIS process's data root (the root, and the
 * legacy name while it is a link to it); a path under none of them is not
 * asked about.
 */
export function dataRootWriteViolationSync(
  path: string,
  root: DataRootView,
): DataRootWriteViolation | null {
  const { roots, existsSync, declaredRootEntriesSync } = root;
  for (const root of roots) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (!path.startsWith(prefix)) continue;
    const [top, child] = path.slice(prefix.length).split("/");
    if (!top) return null;
    if (!KIND_NAMES.has(top))
      return shimRootNames().has(top) || declaredRootEntriesSync().has(top)
        ? null
        : { kind: "root-entry", entry: top };
    if (!child || OPEN_KINDS.has(top)) return null;
    return existsSync(`${prefix}${top}/${child}`)
      ? null
      : { kind: "kind-child", entry: `${top}/${child}` };
  }
  return null;
}

/** What {@link dataRootWriteViolationSync} reads of the root. */
export interface DataRootView {
  roots: readonly string[];
  /** Does this path exist (a `<kind>/<name>` asked about)? */
  existsSync: (path: string) => boolean;
  /** The grandfathered top-level entries some declaration owns — called only when needed. */
  declaredRootEntriesSync: () => ReadonlySet<string>;
}

/**
 * The top-level entries a declaration grandfathers at the root (`postgres`,
 * `sockets`, …), from the data-dirs manifest main publishes at boot: one read
 * on the hook path, where the union of every namespace's manifest (what the
 * audit excuses an entry by) took ~0.9 s over ~250 namespaces. A grandfathered
 * entry is by definition one that already stood before the registry, so a
 * branch never adds one; main's set is the machine's. Only when main has
 * published nothing usable does this fall back to the union. An unreadable
 * manifest excuses nothing here; the audit reports it.
 */
export function machineDeclaredRootEntriesSync(): ReadonlySet<string> {
  const main = readMainManifestSync();
  if (main) return new Set(main.rootEntries);
  const entries = new Set<string>();
  for (const m of readForeignManifestsSync("").manifests)
    for (const e of m.rootEntries) entries.add(e);
  return entries;
}

const KIND_NAMES: ReadonlySet<string> = new Set<string>(DATA_DIR_KINDS);

let shimNames: ReadonlySet<string> | undefined;

/**
 * The legacy names that stand at the root as a link into a declared dir — the
 * only legacy names a write may go through. A name the table expects ABSENT
 * (quarantined, or moved by an unshimmable row) is not one: writing it is
 * exactly how a drained name comes back.
 */
function shimRootNames(): ReadonlySet<string> {
  shimNames ??= new Set(
    legacyRootEntries()
      .filter(
        (e) => e.expect.kind === "symlink" || e.expect.kind === "kind-dir",
      )
      .map((e) => e.name),
  );
  return shimNames;
}
