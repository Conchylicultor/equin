import type { Facet } from "@plugins/plugin-meta/plugins/facets/core";
import { loadFacets } from "@plugins/plugin-meta/plugins/facets/plugins/loader/core";
import { REPO_MEMBERSHIP_URL } from "@plugins/framework/plugins/tooling/core";
import {
  codeIdentity,
  currentRecordStore,
  outsideFilesOf,
  type ModuleGraphInput,
} from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  createStructureIndex,
  pluginTreeDelta,
  type FacetedStart,
  type PluginNode,
  type PluginNodeDelta,
  type PluginTree,
  type PluginTreeData,
  type PluginTreeDelta,
  type StructureIndex,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  batchInputsOf,
  facetKeying,
  facetRecordTexts,
  nodeFacetKeys,
  type FacetKeying,
  type FacetRecordsInput,
} from "./facet-records";
import { recordedPluginFields } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import { relateFacets } from "./faceted-tree";
import { openLiveSnapshot, type LiveRepoSnapshot } from "./live-snapshot";

// The faceted tree kept up to date by what changed, for a reader that lives
// across edits (the backend's faceted-tree worker, plugin-tree's `bin/`).
//
// A plugin's facets are plugin records: a function of the plugin's own files
// (`nodeFacetKeys`), the facet's code and its batch inputs. So the index holds
// a live snapshot of the checkout, the structure index over it, and each
// plugin's record keys and texts; a refresh re-keys only the plugins that own
// a changed path and reads (or extracts) only the records whose key moved.
//
// `relate` is the one whole-tree step: it joins every plugin's data in place.
// It runs only when a record's TEXT or the structure changed — an edit the
// facets do not see (a function body, a test) moves a key but not its text,
// and costs no relate. What the reader is sent is the delta: the facets of
// the plugins whose related data changed (`pluginTreeDelta`).

/** What a refresh did. */
export type FacetedRefresh =
  | { kind: "unchanged" }
  | { kind: "changed"; delta: PluginTreeDelta; nodes: number }
  /**
   * A changed path is code this process loaded (the extractors, the index):
   * what it holds was made by code that is no longer on disk. The caller
   * starts a fresh index in a fresh process.
   */
  | { kind: "code-changed"; path: string };

export interface FacetedIndex {
  /** How the index's snapshot was started (see {@link FacetedResume}). */
  readonly start: FacetedStart;
  /** The whole tree, as a delta against nothing (every node's facets). */
  full(): PluginTreeDelta;
  /**
   * The index's file set as a later process can start from it (see
   * {@link FacetedResume}): as of the last refresh applied. Not re-entrant
   * with `refresh`.
   */
  checkpoint(): Promise<FacetedCheckpoint>;
  /**
   * Bring the index up to date (repo-relative paths, the watcher's batch —
   * see `LiveRepoSnapshot.refresh`). Not re-entrant.
   */
  refresh(
    paths: readonly string[],
    edited: readonly string[],
  ): Promise<FacetedRefresh>;
}

export interface OpenFacetedIndexOptions {
  /** How many file reads the snapshot holds open at once. */
  readConcurrency: number;
  /** Repo-relative files of the code this process runs, asked at each refresh. */
  codeFiles(): Iterable<string>;
  /**
   * Where the snapshot starts from (absent: git, whole). Settled while the
   * facet modules load.
   */
  resume?: Promise<FacetedResume>;
}

/**
 * The checkout's file set as an earlier index held it: every member and its
 * blob id, and the code identity of the membership rule that listed them
 * (`REPO_MEMBERSHIP_URL`) — plain JSON, for the caller to keep across
 * processes.
 *
 * Only the snapshot is kept. Everything else the cold build does is a
 * function of it and of code this process loads anew (the structure from the
 * key-file fold, each plugin's record keys, the records, relate), and costs
 * little once the code identities are computed — which every process does
 * once. The snapshot is the part git answers by walking the whole checkout.
 */
export interface FacetedCheckpoint {
  membership: string;
  members: [string, string][];
  /**
   * When the set was last listed whole by git (epoch ms): carried over by
   * every start from a checkpoint, so its holder can bound how long a set is
   * only ever patched — the journal is blind to a few changes (git's index
   * alone, a linked worktree's exclude file) that a whole listing sees.
   */
  listedAt: number;
}

/**
 * How to start the snapshot: from a checkpoint, refreshing every repo-relative
 * path that may have changed since it was taken (`changed`: a journal's replay
 * since a cursor taken before it), or cold (`reason` says why).
 */
export type FacetedResume =
  | { kind: "checkpoint"; checkpoint: FacetedCheckpoint; changed: string[] }
  | { kind: "cold"; reason: string };

/** The membership rule's code identity over `input`'s checkout. */
function membershipIdentity(input: ModuleGraphInput): Promise<string> {
  return codeIdentity(input, REPO_MEMBERSHIP_URL, "repo-membership");
}

/**
 * The snapshot the index starts from: the checkpoint refreshed by what
 * changed since, when the rule that listed its members is still this
 * process's — else whole, from git.
 */
async function startSnapshot(
  root: AppPath,
  opts: OpenFacetedIndexOptions,
): Promise<{
  snapshot: LiveRepoSnapshot;
  start: FacetedStart;
  listedAt: number;
}> {
  const resume: FacetedResume = (await opts.resume) ?? {
    kind: "cold",
    reason: "no checkpoint asked for",
  };
  if (resume.kind === "checkpoint") {
    const snapshot = await openLiveSnapshot(root, {
      readConcurrency: opts.readConcurrency,
      from: resume.checkpoint.members,
    });
    await snapshot.refresh(resume.changed, []);
    const membership = await membershipIdentity({
      snapshot,
      store: currentRecordStore(),
      readOutside: outsideFilesOf(snapshot),
    });
    if (membership === resume.checkpoint.membership)
      return {
        snapshot,
        start: { kind: "resumed", changed: resume.changed.length },
        listedAt: resume.checkpoint.listedAt,
      };
    return await coldSnapshot(
      root,
      opts,
      "the membership rule changed since the checkpoint",
    );
  }
  return await coldSnapshot(root, opts, resume.reason);
}

/** The snapshot listed whole by git, `reason` saying why. */
async function coldSnapshot(
  root: AppPath,
  opts: OpenFacetedIndexOptions,
  reason: string,
): Promise<{
  snapshot: LiveRepoSnapshot;
  start: FacetedStart;
  listedAt: number;
}> {
  const listedAt = Date.now();
  return {
    snapshot: await openLiveSnapshot(root, {
      readConcurrency: opts.readConcurrency,
    }),
    start: { kind: "cold", reason },
    listedAt,
  };
}

const PLUGINS_REL = "plugins";

export async function openFacetedIndex(
  root: AppPath,
  opts: OpenFacetedIndexOptions,
): Promise<FacetedIndex> {
  // The cold build's steps run as soon as their inputs are there, not one
  // after another: the facet modules load while git lists the checkout, and
  // the structure is built while the facets' code is keyed. Loading is this
  // thread's CPU, the snapshot and the record reads mostly waits.
  const [{ snapshot, start, listedAt }, facets]: [
    { snapshot: LiveRepoSnapshot; start: FacetedStart; listedAt: number },
    Facet[],
  ] = await Promise.all([startSnapshot(root, opts), loadFacets()]);
  // The structure index answers membership from the snapshot, which each
  // refresh brings up to date first: one git question per batch, not two.
  const structureBuilt = createStructureIndex(root, PLUGINS_REL, {
    allMembers: async () => snapshot.all(),
    membersIn: async (paths) =>
      paths.flatMap((p) =>
        snapshot.has(p) ? [p, ...snapshot.under(p)] : snapshot.under(p),
      ),
    // Each key file's facts as folded records (keyed by the blob the
    // snapshot already knows): a cold build parses only the key files no
    // earlier process folded, instead of reading all ~3.8k of them.
    fieldsOf: (plugins) => recordedPluginFields(snapshot, plugins),
  });
  const store = currentRecordStore();
  const input: FacetRecordsInput = {
    snapshot,
    store,
    readOutside: outsideFilesOf(snapshot),
  };
  const [structure, keying]: [StructureIndex, FacetKeying] = await Promise.all([
    structureBuilt,
    facetKeying(input, facets),
  ]);
  const batchInputs = new Set(
    facets.flatMap((f) => f.extractBatch?.inputs ?? []),
  );

  /** Per plugin path: each facet's record key and text. */
  const keys = new Map<string, Map<string, string>>();
  const texts = new Map<string, Map<string, string>>();
  /** Per plugin path: its related facets' JSON, as last sent. */
  const sent = new Map<string, string>();

  /** Key `nodes`, read their records; true when a record text moved. */
  const load = async (nodes: readonly PluginNode[]): Promise<boolean> => {
    const keyed = new Map<PluginNode, Map<string, string>>();
    for (const node of nodes) {
      const next = nodeFacetKeys(snapshot, keying, facets, node);
      const prev = keys.get(node.path);
      if (prev !== undefined && sameMap(prev, next)) continue;
      keyed.set(node, next);
    }
    if (keyed.size === 0) return false;
    const read = await facetRecordTexts(input, facets, keyed);
    await store.flush();
    let moved = false;
    for (const [node, perFacet] of keyed) {
      const nodeTexts = new Map<string, string>();
      for (const [facetId, key] of perFacet) {
        const text = read.get(key);
        if (text === undefined)
          throw new Error(
            `[plugin-tree] no record for facet "${facetId}" of ${node.path}`,
          );
        nodeTexts.set(facetId, text);
      }
      const prev = texts.get(node.path);
      if (prev === undefined || !sameMap(prev, nodeTexts)) moved = true;
      keys.set(node.path, perFacet);
      texts.set(node.path, nodeTexts);
    }
    return moved;
  };

  /** The tree with every record parsed and related, in fresh nodes. */
  const related = async (): Promise<PluginTree> => {
    const tree: PluginTree = {
      ...cloneTree(structure.tree()),
      repo: snapshot,
      facets: facets as Facet[],
    };
    for (const node of tree.byDir.values()) {
      for (const [facetId, text] of texts.get(node.path)!)
        node.facets[facetId] = JSON.parse(text) as unknown;
    }
    await relateFacets(tree);
    return tree;
  };

  // ── cold ──
  await load([...structure.tree().byDir.values()]);
  pluginTreeDelta(await related(), sent);

  return {
    start,
    full: () => fullDelta(structure.tree(), sent),
    async checkpoint() {
      return {
        membership: await membershipIdentity(input),
        members: snapshot.entries(),
        listedAt,
      };
    },
    async refresh(paths, edited) {
      const code = new Set(opts.codeFiles());
      for (const p of [...paths, ...edited]) {
        if (code.has(p)) return { kind: "code-changed", path: p };
        for (const c of code)
          if (c.startsWith(`${p}/`)) return { kind: "code-changed", path: c };
      }

      const change = await snapshot.refresh(paths, edited);
      const structureChanged = await structure.refresh(paths, edited);
      const tree = structure.tree();

      for (const path of [...keys.keys()]) {
        if (tree.byPath.has(path)) continue;
        keys.delete(path);
        texts.delete(path);
      }
      let rekey: PluginNode[];
      if (
        [...change.ids, ...change.membership].some((p) => batchInputs.has(p))
      ) {
        keying.batchInputs = batchInputsOf(snapshot, facets);
        rekey = [...tree.byDir.values()];
      } else {
        // An id that moved changes its owner's manifest only; a member added
        // or removed may also add or drop a folder line of any ancestor's.
        const owners = new Set<PluginNode>();
        for (const p of change.ids) {
          const chain = ownersOf(tree, p);
          if (chain.length > 0) owners.add(chain[chain.length - 1]!);
        }
        for (const p of change.membership)
          for (const n of ownersOf(tree, p)) owners.add(n);
        for (const node of tree.byDir.values())
          if (!keys.has(node.path)) owners.add(node);
        rekey = [...owners];
      }
      const textsMoved = await load(rekey);
      if (!textsMoved && !structureChanged) return { kind: "unchanged" };

      const { delta, changed } = pluginTreeDelta(await related(), sent);
      if (changed === 0 && !structureChanged) return { kind: "unchanged" };
      return { kind: "changed", delta, nodes: changed };
    },
  };
}

/**
 * The plugins whose folder holds repo path `p`, outermost first (the last is
 * its owner).
 */
function ownersOf(tree: PluginTreeData, p: string): PluginNode[] {
  if (!p.startsWith(`${PLUGINS_REL}/`)) return [];
  const segs = p.slice(PLUGINS_REL.length + 1).split("/");
  const out: PluginNode[] = [];
  for (let i = 1; i <= segs.length; i++) {
    const node = tree.byPath.get(segs.slice(0, i).join("/"));
    if (node !== undefined) out.push(node);
  }
  return out;
}

function sameMap(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Fresh nodes over `tree`'s structure, with empty facets — relate mutates.
 * `byDir` keeps the source's order: a relate that lets one plugin win over
 * another (an ambiguous slot's definer) reads it in that order, so a clone in
 * any other order would relate differently from a build.
 */
function cloneTree(tree: PluginTreeData): PluginTreeData {
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  for (const n of tree.byDir.values()) {
    const node: PluginNode = {
      ...n,
      descriptions: { ...n.descriptions },
      runtimes: { ...n.runtimes },
      children: [],
      facets: {},
    };
    byDir.set(node.dir, node);
    byPath.set(node.path, node);
  }
  for (const n of tree.byDir.values())
    byPath.get(n.path)!.children = n.children.map((c) => byPath.get(c.path)!);
  const roots = tree.roots.map((r) => byPath.get(r.path)!);
  return { pluginsRoot: tree.pluginsRoot, byDir, byPath, roots };
}

/** `tree`'s structure with every node's facets as last sent. */
function fullDelta(
  tree: PluginTreeData,
  sent: ReadonlyMap<string, string>,
): PluginTreeDelta {
  const toDelta = (n: PluginNode): PluginNodeDelta => ({
    path: n.path,
    name: n.name,
    id: n.id,
    ...(n.description === undefined ? {} : { description: n.description }),
    descriptions: n.descriptions,
    loadBearing: n.loadBearing,
    collapsed: n.collapsed,
    compositionRoot: n.compositionRoot,
    runtimes: n.runtimes,
    children: n.children.map(toDelta),
    facets: sent.get(n.path)!,
  });
  return { roots: tree.roots.map(toDelta) };
}
