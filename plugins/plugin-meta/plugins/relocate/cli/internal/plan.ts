// The pure half of `./equin plugin move`: given the move, the refs the
// plugin-refs locator found and the texts of the files they sit in, compute
// every rename and every edit — touching no filesystem and no git. `move.ts`
// is the thin shell that gathers the inputs and applies the result, so what a
// move would do is exactly what `--dry-run` prints.

import {
  asFsPath,
  asPath,
  asPluginId,
  packageNameFor,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { withPackageName } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  isWithinDir,
  pluginDirOfRef,
  relativeLinkFrom,
  resolveRelativeRef,
  type DotRefSite,
  type PathRefSyntax,
  type PluginRef,
  type RelativeRef,
  type RelativeRefSyntax,
} from "@plugins/plugin-meta/plugins/plugin-refs/core";
import { movedPluginId } from "../../core";

const PLUGINS_DIR = "plugins";
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** One plugin location, in every spelling a move has to rewrite. */
export interface PluginLocation {
  id: PluginId;
  /** The plugin directory, repo-relative: `plugins/a/plugins/b`. */
  dir: string;
  /** The config store dir, repo-relative: `config/a/b` (`asPath`). */
  configDir: string;
}

export function locationOf(id: PluginId): PluginLocation {
  return {
    id,
    dir: `${PLUGINS_DIR}/${asFsPath(id)}`,
    configDir: `config/${asPath(id)}`,
  };
}

/**
 * A command-line plugin argument, as a path (`plugins/a/plugins/b`, `./` and a
 * trailing `/` tolerated) or a dot id (`a.b`). Throws on anything that is not
 * one of the two spellings — a path whose odd segments are not `plugins` names
 * a folder inside a plugin, not a plugin.
 */
export function parsePluginArg(arg: string): PluginLocation {
  const raw = arg.trim();
  let segs: string[];
  if (raw.includes("/")) {
    const path = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const parts = path.split("/");
    if (parts[0] !== PLUGINS_DIR || parts.length % 2 !== 0) {
      throw new Error(
        `"${arg}" is not a plugin path — expected plugins/<a>(/plugins/<b>)*`,
      );
    }
    segs = [];
    for (let i = 1; i < parts.length; i += 2) {
      if (i > 1 && parts[i - 1] !== PLUGINS_DIR) {
        throw new Error(
          `"${arg}" is not a plugin path — "${parts[i - 1]}" sits where a nested plugin's "plugins/" folder must`,
        );
      }
      segs.push(parts[i]!);
    }
  } else {
    segs = raw.split(".");
  }
  const bad = segs.find((s) => !SEGMENT_RE.test(s));
  if (bad !== undefined) {
    throw new Error(
      `"${arg}" is not a plugin path or dot id — bad segment "${bad}"`,
    );
  }
  return locationOf(asPluginId(segs.join(".")));
}

export interface Move {
  from: PluginLocation;
  to: PluginLocation;
}

function swapPrefix(value: string, from: string, to: string): string | null {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
  return null;
}

/**
 * Where a repo path lands after the move: under the moved plugin dir or its
 * config dir it is re-rooted, anything else stays. Covers every descendant,
 * since both trees nest.
 */
export function mapRepoPath(move: Move, path: string): string {
  return (
    swapPrefix(path, move.from.dir, move.to.dir) ??
    swapPrefix(path, move.from.configDir, move.to.configDir) ??
    path
  );
}

/** The moved spelling of a dot id, or null when it is outside the moved subtree. */
export function mapPluginId(move: Move, id: PluginId): PluginId | null {
  return movedPluginId(id, move.from.id, move.to.id);
}

/** A `[start, end)` replacement in one file's text. */
export interface PlannedEdit {
  ref: PluginRef;
  replacement: string;
}

/** Which bucket a ref's edit is counted in, for the report. */
export type EditKind =
  | `path:${PathRefSyntax}`
  | `dot:${DotRefSite}`
  | `relative:${RelativeRefSyntax}`;

export function editKind(ref: PluginRef): EditKind {
  switch (ref.kind) {
    case "path":
      return `path:${ref.syntax}`;
    case "dot":
      return `dot:${ref.site}`;
    case "relative":
      return `relative:${ref.syntax}`;
  }
}

/**
 * Files a move never edits by hand: a build rewrites them from their source —
 * codegen, the lockfile, and config snapshots (an `.origin.jsonc` is generated
 * from its `defineConfig` defaults or the slot catalog, so the build needs the
 * PRE-move origin on disk to tell a pure move from a real default change; see
 * `restampMovedOverrides`).
 */
function isDerivedFile(file: string): boolean {
  return (
    file.endsWith(".generated.ts") ||
    file === "bun.lock" ||
    file.endsWith(".origin.jsonc") ||
    file.endsWith(".ancestor.jsonc")
  );
}

/**
 * The new text for a relative ref, or null when it does not change. The target
 * is resolved against the source's OLD location, mapped through the move, and
 * re-relativized from the source's NEW location — so it is right whether the
 * source moved, the target moved, or both (both: the link is unchanged).
 *
 * Spelling is kept where it means something: a leading `./` (a CSS `@import`
 * without one is a package, not a path), a trailing `/`, percent-encoding.
 */
function rewriteRelative(move: Move, ref: RelativeRef): string | null {
  const resolved = resolveRelativeRef(ref);
  const sourceMoves = mapRepoPath(move, ref.file) !== ref.file;
  if (resolved.kind === "outside") {
    // Points above the repo root: only a moving source changes it.
    if (!sourceMoves) return null;
  } else if (
    !sourceMoves &&
    mapRepoPath(move, resolved.target) === resolved.target
  ) {
    return null;
  }
  const newSource = mapRepoPath(move, ref.file);
  const newTarget =
    resolved.kind === "inside"
      ? mapRepoPath(move, resolved.target)
      : resolved.target;
  let next = relativeLinkFrom(newSource, newTarget);
  if (
    (ref.value.startsWith("./") || ref.syntax.startsWith("css-")) &&
    !next.startsWith("./") &&
    !next.startsWith("../")
  ) {
    next = `./${next}`;
  }
  if (ref.value.endsWith("/") && !next.endsWith("/")) next = `${next}/`;
  if (ref.value.includes("%")) next = encodeURI(next);
  return next === ref.value ? null : next;
}

/**
 * The edit a ref needs under the move, or null when it is untouched:
 *  - a path ref naming a plugin dir inside the moved subtree — swap the prefix;
 *  - a dot ref naming an id inside it — swap the id prefix;
 *  - a relative ref whose target OR source moves — re-relativize.
 * Derived files are skipped (a build regenerates them), and so is everything
 * but links in `research/` (dated prose is never rewritten; its links are).
 */
export function editFor(move: Move, ref: PluginRef): PlannedEdit | null {
  if (isDerivedFile(ref.file)) return null;
  if (ref.file.startsWith("research/") && ref.kind !== "relative") return null;
  let replacement: string | null;
  switch (ref.kind) {
    case "path":
      replacement = isWithinDir(pluginDirOfRef(ref), move.from.dir)
        ? swapPrefix(ref.value, move.from.dir, move.to.dir)
        : null;
      break;
    case "dot":
      replacement = mapPluginId(move, ref.id);
      break;
    case "relative":
      replacement = rewriteRelative(move, ref);
      break;
  }
  if (replacement === null || replacement === ref.value) return null;
  return { ref, replacement };
}

/**
 * `text` with `edits` applied back-to-front. Each edit's range must still hold
 * its ref's value (the file changed since it was scanned otherwise), and no two
 * may overlap (one character rewritten twice) — both throw rather than write a
 * corrupt file.
 */
export function applyEdits(
  file: string,
  text: string,
  edits: readonly PlannedEdit[],
): string {
  const sorted = [...edits].sort(
    (a, b) => b.ref.range.start - a.ref.range.start,
  );
  let out = text;
  let floor = Infinity;
  for (const { ref, replacement } of sorted) {
    const { start, end } = ref.range;
    if (end > floor) {
      throw new Error(
        `${file}:${ref.line}: two references overlap at offset ${start} — refusing to rewrite one span twice`,
      );
    }
    const at = text.slice(start, end);
    if (at !== ref.value) {
      throw new Error(
        `${file}:${ref.line}: expected ${JSON.stringify(ref.value)} at offset ${start}, found ${JSON.stringify(at)} — the file changed since it was scanned`,
      );
    }
    out = out.slice(0, start) + replacement + out.slice(end);
    floor = start;
  }
  return out;
}

/** One file the move rewrites. */
export interface FileRewrite {
  /** Where the file is now. */
  file: string;
  /** Where it will be (differs when it sits in a moved dir). */
  newFile: string;
  edits: PlannedEdit[];
  /** The rewritten text. */
  text: string;
}

/** A moved plugin whose `package.json` name is re-derived. */
export interface PackageRename {
  file: string;
  newFile: string;
  from: string;
  to: string;
  text: string;
}

/**
 * A CSS `@source` glob that covered the moved plugin from outside it and no
 * longer will — the silently-narrowed-glob class: nothing breaks, Tailwind just
 * stops seeing the moved plugin's classes.
 */
export interface NarrowedGlob {
  ref: RelativeRef;
  target: string;
}

export interface MovePlan {
  move: Move;
  /** Every moved plugin, old → new id. */
  plugins: Array<{ from: PluginId; to: PluginId }>;
  /** `git mv` pairs: the plugin dir, then its config dir when it has one. */
  renames: Array<{ from: string; to: string }>;
  rewrites: FileRewrite[];
  packages: PackageRename[];
  counts: Map<EditKind, number>;
  narrowedGlobs: NarrowedGlob[];
}

export interface MovePlanInput {
  move: Move;
  /** Ids of the moved plugin and every descendant (from the plugin tree). */
  movedIds: readonly PluginId[];
  /** Ids among them that are composition roots (their names are their own). */
  compositionRoots: ReadonlySet<PluginId>;
  /** Whether `config/<old slash path>` holds any file. */
  hasConfigDir: boolean;
  refs: readonly PluginRef[];
  /** Text of every file a ref sits in and every moved `package.json`. */
  read: (file: string) => string | null;
}

function staticPrefixCovers(ref: RelativeRef, dir: string): string | null {
  const resolved = resolveRelativeRef(ref);
  if (resolved.kind !== "inside") return null;
  const prefix = resolved.staticPath;
  const covers = (d: string) => prefix === "" || isWithinDir(d, prefix);
  return covers(dir) ? resolved.target : null;
}

export function planMove(input: MovePlanInput): MovePlan {
  const { move } = input;
  const plugins = input.movedIds.map((id) => {
    const to = mapPluginId(move, id);
    if (to === null) {
      throw new Error(`${id} is not inside ${move.from.id}`);
    }
    return { from: id, to };
  });

  const renames = [{ from: move.from.dir, to: move.to.dir }];
  if (input.hasConfigDir) {
    renames.push({ from: move.from.configDir, to: move.to.configDir });
  }

  const byFile = new Map<string, PlannedEdit[]>();
  const counts = new Map<EditKind, number>();
  const narrowedGlobs: NarrowedGlob[] = [];
  for (const ref of input.refs) {
    const edit = editFor(move, ref);
    if (edit !== null) {
      const list = byFile.get(ref.file) ?? [];
      list.push(edit);
      byFile.set(ref.file, list);
      const kind = editKind(ref);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (
      ref.kind === "relative" &&
      ref.glob &&
      mapRepoPath(move, ref.file) === ref.file
    ) {
      const target = staticPrefixCovers(ref, move.from.dir);
      if (target !== null && staticPrefixCovers(ref, move.to.dir) === null) {
        narrowedGlobs.push({ ref, target });
      }
    }
  }

  const rewrites: FileRewrite[] = [];
  for (const [file, edits] of [...byFile].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const text = input.read(file);
    if (text === null)
      throw new Error(`${file}: has references but could not be read`);
    rewrites.push({
      file,
      newFile: mapRepoPath(move, file),
      edits,
      text: applyEdits(file, text, edits),
    });
  }

  const packages: PackageRename[] = [];
  for (const { from, to } of plugins) {
    if (input.compositionRoots.has(from)) continue;
    const file = `${PLUGINS_DIR}/${asFsPath(from)}/package.json`;
    const text = input.read(file);
    // No package.json is R1's finding (plugin-boundaries), not the mover's.
    if (text === null) continue;
    const name = packageNameFor(asFsPath(to));
    const next = withPackageName(text, name, file);
    if (next === text) continue;
    const current: unknown = (JSON.parse(text) as { name?: unknown }).name;
    packages.push({
      file,
      newFile: mapRepoPath(move, file),
      from: typeof current === "string" ? current : "(none)",
      to: name,
      text: next,
    });
  }

  return { move, plugins, renames, rewrites, packages, counts, narrowedGlobs };
}
