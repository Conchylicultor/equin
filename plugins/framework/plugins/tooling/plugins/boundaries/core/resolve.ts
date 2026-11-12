import { sep } from "path";
import {
  PLUGIN_FOLDERS,
  RUNTIME_FOLDERS,
  TESTING_FOLDER,
  isTestCodePath,
  type PluginFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import type { ZoneDefinition } from "./types";

/** Why a path inside a plugin has no folder. */
export type UnfolderedReason =
  /** A file directly in a plugin directory. */
  | "loose-file"
  /** The first segment under the plugin is not in `PLUGIN_FOLDERS`. */
  | "unknown-folder"
  /** Under the plugin's `plugins/`, but inside no discovered child plugin. */
  | "not-in-child-plugin"
  /** A `testing/` directory that is not directly under a runtime folder, or
   *  sits under `e2e/` (which verifies by driving the app, not by importing). */
  | "misplaced-testing";

/**
 * Where a path lands. There is no "no folder" arm: a path inside a plugin
 * either sits in one of the plugin's folders, or is `unfoldered` and gets
 * reported.
 */
export type Resolved =
  /** Not under a plugin: an npm package, a file outside `plugins/`. */
  | { kind: "outside" }
  | {
      kind: "folder";
      zone: string;
      folder: PluginFolder;
      /** Test code (`isTestCodePath`): follows `folder`'s row, and only code
       *  that verifies may import it. */
      test: boolean;
    }
  | {
      kind: "unfoldered";
      zone: string;
      why: UnfolderedReason;
      /** The segment that decided it: the file name, or the folder name. */
      name: string;
    };

export interface ZoneMap {
  allZones: Set<string>;
  resolveFile(relFile: string): Resolved;
  /**
   * Where an import lands, from the importing file (repo-relative) and its
   * specifier. Relative and `@plugins/…` specifiers are classified exactly
   * like a file; anything else (npm packages, a path leaving `plugins/`) is
   * `outside`.
   */
  resolveImport(fromRelFile: string, specifier: string): Resolved;
}

const OUTSIDE: Resolved = { kind: "outside" };
const FOLDERS: ReadonlySet<string> = new Set(PLUGIN_FOLDERS);
// The folders a `testing/` directory may sit directly under: every barrel
// folder but `e2e`, whose scripts get no test helpers.
const TESTING_HOSTS: ReadonlySet<string> = new Set(
  RUNTIME_FOLDERS.filter((f) => f !== "e2e"),
);
const isPluginFolder = (name: string): name is PluginFolder =>
  FOLDERS.has(name);

/**
 * Classify the path inside one plugin (the segments after the plugin's own
 * directory). The longest-prefix plugin match already chose the deepest
 * plugin, so a first segment of `plugins` here means no child claimed it.
 *
 * A lone folder name is the folder itself: a barrel specifier
 * (`@plugins/x/web`) or a directory import (`../shared`), i.e. its index. A
 * real loose file always carries its extension, so it never reads as one.
 */
function classify(zone: string, inside: string[]): Resolved {
  const [first = "", ...rest] = inside;
  if (isPluginFolder(first)) {
    const at = rest.indexOf(TESTING_FOLDER);
    if (at > 0 || (at === 0 && !TESTING_HOSTS.has(first))) {
      return {
        kind: "unfoldered",
        zone,
        why: "misplaced-testing",
        name: [first, ...rest.slice(0, at + 1)].join("/"),
      };
    }
    return {
      kind: "folder",
      zone,
      folder: first,
      test: isTestCodePath(inside),
    };
  }
  if (rest.length === 0) {
    return { kind: "unfoldered", zone, why: "loose-file", name: first };
  }
  if (first === "plugins") {
    return {
      kind: "unfoldered",
      zone,
      why: "not-in-child-plugin",
      name: first,
    };
  }
  return { kind: "unfoldered", zone, why: "unknown-folder", name: first };
}

/**
 * The part of the plugin tree the zone map reads: each plugin's id and its
 * path under `plugins/`. A full `PluginTree` satisfies it.
 */
export interface PluginDirs {
  byDir: ReadonlyMap<string, { id: string; path: string }>;
}

export function buildZoneMap(
  zones: ZoneDefinition[],
  pluginTree: PluginDirs | null,
): ZoneMap {
  const allZones = new Set<string>();

  const pluginHierarchyToZone = new Map<string, string>();
  const pluginRelPathToHierarchy = new Map<string, string>();

  for (const z of zones) {
    allZones.add(z.name);

    if (z.discover === "plugin-tree" && pluginTree) {
      for (const node of pluginTree.byDir.values()) {
        const zoneName = `${z.name}.${node.id}`;
        allZones.add(zoneName);
        pluginHierarchyToZone.set(node.id, zoneName);
        pluginRelPathToHierarchy.set(node.path, node.id);
      }
    }
  }

  const pluginZoneDef = zones.find((z) => z.discover === "plugin-tree");
  const pluginDirPrefix = pluginZoneDef ? pluginZoneDef.match + "/" : null;
  const pluginZoneName = pluginZoneDef?.name ?? "plugin";

  const sortedPluginPaths = Array.from(pluginRelPathToHierarchy.keys()).sort(
    (a, b) => b.length - a.length,
  );

  function resolveFile(relFile: string): Resolved {
    const norm = relFile.split(sep).join("/");

    if (pluginDirPrefix && norm.startsWith(pluginDirPrefix)) {
      const rest = norm.slice(pluginDirPrefix.length);
      for (const pluginPath of sortedPluginPaths) {
        const zone = `${pluginZoneName}.${pluginRelPathToHierarchy.get(pluginPath)!}`;
        // The plugin directory itself (a relative `../..` import): its index.
        if (rest === pluginPath) return classify(zone, []);
        if (rest.startsWith(pluginPath + "/")) {
          return classify(zone, rest.slice(pluginPath.length + 1).split("/"));
        }
      }
      // Under `plugins/` but inside no plugin: `plugins/` is a container of
      // plugins at every level, including the top.
      return {
        kind: "unfoldered",
        zone: pluginZoneName,
        why: "not-in-child-plugin",
        name: rest.split("/")[0]!,
      };
    }

    return OUTSIDE;
  }

  function resolveImport(fromRelFile: string, specifier: string): Resolved {
    // A relative specifier is read the same way as the file it points at:
    // resolve it against the importing file's directory, then classify that
    // path. So `../server/x` from `core/` lands in the plugin's own `server`
    // folder, and `../../..` out of a child plugin lands in its parent.
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const target = joinRelative(fromRelFile, specifier);
      return target === null ? OUTSIDE : resolveFile(target);
    }

    if (specifier.startsWith("@plugins/")) {
      const rest = specifier.slice("@plugins/".length);
      const parts = rest.split("/");

      let bestHierarchy: string | null = null;
      let bestLen = 0;
      for (let i = 1; i <= parts.length; i++) {
        const candidate = parts.slice(0, i).join("/");
        if (pluginRelPathToHierarchy.has(candidate) && i > bestLen) {
          bestHierarchy = pluginRelPathToHierarchy.get(candidate)!;
          bestLen = i;
        }
      }

      if (!bestHierarchy) return OUTSIDE;

      // `@plugins/x` alone names the plugin, not a folder of it.
      return classify(
        `${pluginZoneName}.${bestHierarchy}`,
        parts.slice(bestLen),
      );
    }

    return OUTSIDE;
  }

  return { allZones, resolveFile, resolveImport };
}

/**
 * Resolve a relative specifier against a repo-relative file, in posix
 * segments. Null when it climbs above the repo root.
 */
function joinRelative(fromRelFile: string, specifier: string): string | null {
  const out = fromRelFile.split(sep).join("/").split("/").slice(0, -1);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}
