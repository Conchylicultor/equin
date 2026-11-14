import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  assemblePluginTree,
  collectPluginFields,
  keyFileOwner,
  pluginPositionsOf,
  type PluginFields,
  type PluginTreeData,
} from "./plugin-tree";

// The structure tree kept up to date by what changed, not rebuilt.
//
// A node is a function of two things only: whether its folder holds any file of
// the repo's set (`pluginPositionsOf` — the content gate), and the text of its
// own key files (`PLUGIN_KEY_FILES`). So the index holds exactly those inputs —
// the member files under the plugins root (sorted, for range queries), how many
// members support each plugin position, and each plugin's read fields — and a
// refresh of some paths re-asks the file set about those paths only, moves the
// support counts, and re-reads the key files of the plugins they touch. An edit
// to any other file costs one membership query and changes nothing.
//
// Only the cold `createStructureIndex` lists the whole plugins root. Linking the
// nodes into a tree (`assemblePluginTree`) is pure and in memory, and runs only
// when a refresh actually changed a plugin.

/** What the index reads through: the repo's file set, asked per path. */
interface StructureMembershipIo {
  /**
   * Every member of the repo's file set (repo-relative, the `RepoFiles` rule),
   * for the cold build. Whole-repo rather than scoped to the plugins root:
   * git answers the whole tree from its untracked cache, and a scoped listing
   * walks the scope (`listAllRepoMembers`).
   */
  allMembers(): Promise<readonly string[]>;
  /**
   * The members of the repo's file set (repo-relative, the `RepoFiles` rule)
   * at or under each of `paths` — each a file or a folder, present or gone.
   */
  membersIn(paths: readonly string[]): Promise<readonly string[]>;
}

/**
 * How the index learns a plugin's fields, one of two ways:
 *
 * - `read` — each key file's working-tree text, parsed here (a backend: no
 *   record store in its closure).
 * - `fieldsOf` — the fields of the plugins asked (paths under the plugins
 *   root), from a reader that already knows them: build tooling folding each
 *   key file's facts as records keyed by its blob (`structure-records`), so a
 *   cold build reads and parses only the key files no earlier process did,
 *   not all ~3.8k. Asked after the membership it is given moved, so it must
 *   answer from a file set at least as fresh. Every plugin asked must be
 *   answered.
 */
export type StructureIndexIo = StructureMembershipIo &
  (
    | {
        /** A member's working-tree text (repo-relative), or null when it vanished. */
        read(path: string): Promise<string | null>;
      }
    | {
        fieldsOf(
          plugins: readonly string[],
        ): Promise<ReadonlyMap<string, PluginFields>>;
      }
  );

export interface StructureIndex {
  /** The current tree. A new value after each refresh that changed it. */
  tree(): PluginTreeData;
  /**
   * Bring the index up to date with what changed (repo-relative paths; one
   * outside the plugins root is ignored). True when the tree changed. Safe to
   * repeat: a path already up to date is a no-op. Not re-entrant — the caller
   * runs one refresh at a time.
   *
   * - `paths`: anything may have happened at or under each (created, removed,
   *   moved, a folder or a file) — re-asked of the file set.
   * - `edited`: files whose content changed and that still exist (a watcher's
   *   `update`). One that is already a member cannot have changed membership,
   *   so nothing is asked about it — only a key file is re-read; any other is
   *   handled as one of `paths`. A `.gitignore` among either moves what its
   *   folder holds, so that folder is re-asked.
   */
  refresh(
    paths: readonly string[],
    edited?: readonly string[],
  ): Promise<boolean>;
}

function lowerBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Members strictly under `dir`: the range [`dir/`, `dir0`) — `0` follows `/`.
// Local rather than tooling's `pathsUnder`: this module sits in plugin-tree's
// core barrel, whose `resolvePluginSpecifier` facet extractors import, and
// tooling's barrel would widen every such extractor's record key.
function rangeUnder(sorted: readonly string[], dir: string): string[] {
  return sorted.slice(
    lowerBound(sorted, `${dir}/`),
    lowerBound(sorted, `${dir}0`),
  );
}

function sameFields(a: PluginFields, b: PluginFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the index cold: list the plugins root once, read every plugin's key
 * files, assemble. `pluginsRoot` sits under `repoRoot`; `pluginsRel` is its
 * repo-relative spelling.
 */
export async function createStructureIndex(
  repoRoot: AppPath,
  pluginsRel: string,
  io: StructureIndexIo,
): Promise<StructureIndex> {
  const pluginsRoot = joinAppPath(repoRoot, ...pluginsRel.split("/"));
  const prefix = `${pluginsRel}/`;
  // Member files under the plugins root, repo-relative, sorted.
  const members: string[] = [];
  const support = new Map<string, number>();
  const fields = new Map<string, PluginFields>();

  /** The fields of each of `plugins`, through whichever reader `io` has. */
  const fieldsOf = async (
    plugins: readonly string[],
  ): Promise<ReadonlyMap<string, PluginFields>> => {
    if ("fieldsOf" in io) {
      const out = await io.fieldsOf(plugins);
      for (const plugin of plugins)
        if (!out.has(plugin))
          throw new Error(
            `[plugin-tree] the structure index's fieldsOf answered no fields for ${plugin}`,
          );
      return out;
    }
    const { read } = io;
    const read1 = (plugin: string): Promise<PluginFields> =>
      collectPluginFields(
        joinAppPath(pluginsRoot, ...plugin.split("/")),
        (keyFile) => {
          const path = `${prefix}${plugin}/${keyFile}`;
          const i = lowerBound(members, path);
          return members[i] === path ? read(path) : Promise.resolve(null);
        },
      );
    return new Map(
      await Promise.all(plugins.map(async (p) => [p, await read1(p)] as const)),
    );
  };

  const addSupport = (member: string, delta: number, moved: Set<string>) => {
    for (const plugin of pluginPositionsOf(member.slice(prefix.length))) {
      const before = support.get(plugin) ?? 0;
      const after = before + delta;
      if (after === 0) support.delete(plugin);
      else support.set(plugin, after);
      if ((before === 0) !== (after === 0)) moved.add(plugin);
    }
  };

  // ── cold ──
  const listed = (await io.allMembers()).filter((m) => m.startsWith(prefix));
  listed.sort();
  members.push(...listed);
  const coldMoved = new Set<string>();
  for (const m of members) addSupport(m, +1, coldMoved);
  for (const [plugin, f] of await fieldsOf([...support.keys()]))
    fields.set(plugin, f);
  let tree = assemblePluginTree(pluginsRoot, fields);

  /** The members at or under `region`: the exact path, then its subtree. */
  const membersAt = (region: string): string[] => {
    const at: string[] = [];
    const i = lowerBound(members, region);
    if (members[i] === region) at.push(region);
    at.push(...rangeUnder(members, region));
    return at;
  };

  /** Drop nested regions: a path under another one is already covered. */
  const regionsOf = (paths: readonly string[]): string[] => {
    const inside = paths.filter(
      (p) => p === pluginsRel || p.startsWith(prefix),
    );
    const sorted = [...new Set(inside)].sort();
    const out: string[] = [];
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last !== undefined && p.startsWith(`${last}/`)) continue;
      out.push(p);
    }
    return out;
  };

  return {
    tree: () => tree,
    async refresh(paths, edited = []) {
      // Plugins whose fields must be re-read: a position that appeared or
      // vanished, and the owner of every key file added, removed or touched.
      const touched = new Set<string>();
      const owner = (member: string) => {
        const plugin = keyFileOwner(member.slice(prefix.length));
        if (plugin !== null) touched.add(plugin);
      };

      const asked: string[] = [];
      for (const path of [...paths, ...edited]) {
        if (path === ".gitignore" || path.endsWith("/.gitignore")) {
          asked.push(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
        }
      }
      for (const path of edited) {
        if (members[lowerBound(members, path)] === path) owner(path);
        else asked.push(path);
      }
      asked.push(...paths);

      const regions = regionsOf(asked);
      const now = new Set(
        regions.length === 0 ? [] : await io.membersIn(regions),
      );
      const before = new Set(regions.flatMap(membersAt));
      for (const m of before) {
        owner(m);
        if (now.has(m)) continue;
        members.splice(lowerBound(members, m), 1);
        addSupport(m, -1, touched);
      }
      for (const m of now) {
        if (before.has(m)) continue;
        owner(m);
        members.splice(lowerBound(members, m), 0, m);
        addSupport(m, +1, touched);
      }

      let changed = false;
      const reread: string[] = [];
      for (const plugin of touched) {
        if (support.has(plugin)) reread.push(plugin);
        else if (fields.delete(plugin)) changed = true;
      }
      if (reread.length > 0) {
        for (const [plugin, next] of await fieldsOf(reread)) {
          const prev = fields.get(plugin);
          if (prev !== undefined && sameFields(prev, next)) continue;
          fields.set(plugin, next);
          changed = true;
        }
      }
      if (changed) tree = assemblePluginTree(pluginsRoot, fields);
      return changed;
    },
  };
}
