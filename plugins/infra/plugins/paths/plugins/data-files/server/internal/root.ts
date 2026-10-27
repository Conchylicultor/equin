import type { DataChangeHandler, DataWatch, Mount } from "../../core";
import {
  DataFiles,
  type FileRootBrowseSpec,
  type FileRootSpec,
  type FileRootStore,
  type FileRootWatchSpec,
} from "./service";

/**
 * A declared file root: one data dir's files, reached through whichever
 * {@link DataFiles} provider the host booted. Declared once, by the plugin that
 * owns the data dir (or a descendant), in its `server/`.
 */
export interface FileRoot extends Mount {
  readonly id: string;
  readonly spec: FileRootSpec;
}

/**
 * A root declared with a `watch`: the only kind with `watch` to call — an
 * unwatched root has no spelling of it (`defineFileRoot`'s return type).
 */
export interface WatchedFileRoot extends FileRoot {
  /**
   * Hear the root's changes, from every writer — this process, another one,
   * an agent's editor. Resolves once changes flow.
   */
  watch(onChange: DataChangeHandler): Promise<DataWatch>;
}

/** What `defineFileRoot(spec)` returns: watchable iff the literal spec declares `watch`. */
export type FileRootOf<S extends FileRootSpec> = S extends {
  readonly watch: FileRootWatchSpec;
}
  ? WatchedFileRoot
  : FileRoot;

/**
 * A spec declaring `browse` must declare `watch` too: a browser's reads are
 * pushed from the root's watch. Intersected into `defineFileRoot`'s parameter,
 * so the missing `watch` is a tsc error at the declaration.
 */
type BrowseNeedsWatch<S> = S extends { readonly browse: FileRootBrowseSpec }
  ? S extends { readonly watch: FileRootWatchSpec }
    ? unknown
    : { readonly watch: FileRootWatchSpec }
  : unknown;

// Every root whose declaring module has been evaluated. The desktop provider's
// register phase reads it to prove each one bound to a location — by then every
// barrel of the graph has loaded, so every declaration has run.
const declared = new Map<string, FileRoot>();
// The declared roots that opt in to browsing (`browse`), each watched.
const browsable = new Map<string, WatchedFileRoot>();

// A root id names the root in URLs and messages: dotted kebab.
const ROOT_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Declare a file root over a data dir the declaring plugin (or an ancestor)
 * owns. Every operation delegates to the host's {@link DataFiles} provider, read
 * at call time — so a root is declared at module scope and used once booted.
 *
 * ```ts
 * export const prototypesFiles = defineFileRoot({
 *   id: "apps.prototypes",
 *   dir: "apps/prototypes",
 *   watch: { name: "prototypes-files.tree", description: "…", extensions: [".html"] },
 * });
 * // and in the owner's machine/: contributions: [FileRootLocation(prototypesFiles, prototypesDir)]
 * ```
 */
export function defineFileRoot<const S extends FileRootSpec>(
  spec: S & BrowseNeedsWatch<S>,
): FileRootOf<S> {
  if (!ROOT_ID_RE.test(spec.id)) {
    throw new Error(
      `[data-files] root id "${spec.id}" must be dotted lowercase kebab (e.g. "apps.prototypes")`,
    );
  }
  if (spec.browse !== undefined && spec.watch === undefined) {
    throw new Error(
      `[data-files] root "${spec.id}" declares \`browse\` without \`watch\` — a browser's reads are pushed from the root's watch`,
    );
  }
  if (declared.has(spec.id)) {
    throw new Error(
      `[data-files] file root "${spec.id}" is declared twice — a root id names one root`,
    );
  }
  const store = (): FileRootStore => DataFiles.get().root(spec);
  const mount: FileRoot = {
    id: spec.id,
    spec,
    list: (dir) => store().list(dir),
    stat: (path) => store().stat(path),
    read: (path) => store().read(path),
    write: (path, data, opts) => store().write(path, data, opts),
    remove: (path, opts) => store().remove(path, opts),
    rename: (from, to, opts) => store().rename(from, to, opts),
    withLock: (key, fn) => store().withLock(key, fn),
  };
  const root: FileRoot | WatchedFileRoot =
    spec.watch === undefined
      ? mount
      : { ...mount, watch: (onChange) => store().watch(onChange) };
  declared.set(spec.id, root);
  if (spec.browse !== undefined && "watch" in root)
    browsable.set(spec.id, root);
  // `FileRootOf<S>` is decided by the same `spec.watch` the line above reads;
  // tsc cannot narrow a conditional type through a runtime check.
  return root as FileRootOf<S>;
}

/** Every root declared in this process, in declaration order. */
export function listFileRoots(): readonly FileRoot[] {
  return [...declared.values()];
}

/**
 * The roots declared `browse` in this process, in declaration order — what the
 * read surface (`data-files.list` / `.stat` / `.text`, the raw route) serves.
 */
export function browsableFileRoots(): readonly WatchedFileRoot[] {
  return [...browsable.values()];
}

/** The browsable root `id`, or `undefined` when no root of that id opts in. */
export function browsableFileRoot(id: string): WatchedFileRoot | undefined {
  return browsable.get(id);
}
