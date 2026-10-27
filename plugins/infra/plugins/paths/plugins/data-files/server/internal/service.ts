import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { DataDirRef } from "@plugins/infra/plugins/paths/core";
import type { DataChangeHandler, DataWatch, Mount, RelPath } from "../../core";

/**
 * How a root's changes are heard on the desktop: the static policy of the
 * declared file watcher the provider opens over it (`defineFileWatcher`) — its
 * Background-catalog name and sentence and the extensions that pass. A watch
 * that reports dropped events (`onLost`) is delivered as `{ kind: "rescan" }`
 * — there is no reconcile timer (`infra/file-watcher`). Every host filters
 * changed paths by `extensions`, so what a consumer hears does not depend on
 * which host it runs on.
 */
export interface FileRootWatchSpec {
  /** The watcher's catalog name, unique per process (`prototypes-files.tree`). */
  name: string;
  /** One present-tense sentence: what it notices and why. */
  description: string;
  /** Only paths ending in one of these are reported (`[".html", ".css"]`). */
  extensions?: readonly string[];
}

/**
 * Agent-origin writes under `under` are revertible: the desktop provider
 * snapshots each file before an agent's first write to it, in the shared
 * agent-write ledger, so the e2e harness can put it back. A ledgered area holds
 * text files (the ledger keeps UTF-8).
 */
export interface FileRootLedgerSpec {
  /** The ledger's id — one lowercase kebab segment, stable (it names its file). */
  id: string;
  /** What the harness prints, e.g. "Prototype option picks". */
  label: string;
  under: RelPath;
}

/**
 * A root a generic browser may show (the file explorer's "App data" place),
 * read-only — through `data-files.list` / `.stat` / `.text` and the raw route.
 * Only a watched root may opt in: what a browser shows is pushed from the
 * root's watch (`defineFileRoot` refuses `browse` without `watch`).
 */
export interface FileRootBrowseSpec {
  /** What a person calls it, e.g. "Prototypes". */
  label: string;
}

/**
 * A file root's portable identity: which declared data dir it is, and its
 * policies. Never an absolute path — a host binds the dir to a location
 * (the desktop's `FileRootLocation`), or keeps the files somewhere else.
 */
export interface FileRootSpec {
  /** Unique, a string literal (the `data-files:*` checks read it statically). */
  readonly id: string;
  /** The data dir the root is, as `${kind}/${name}` (`"apps/prototypes"`), a string literal. */
  readonly dir: DataDirRef;
  readonly watch?: FileRootWatchSpec;
  readonly ledger?: FileRootLedgerSpec;
  /** Shown, read-only, by a generic browser. Needs `watch`. */
  readonly browse?: FileRootBrowseSpec;
}

/** One root's files on this host: the Mount operations plus its watch. */
export interface FileRootStore extends Mount {
  /**
   * Hear the root's changes, from every writer — this process, another one, an
   * agent's editor. Resolves once changes flow. Reached only through a
   * `WatchedFileRoot`, so only for a root that declares `watch`; a provider
   * still throws for one that does not.
   */
  watch(onChange: DataChangeHandler): Promise<DataWatch>;
}

/**
 * What a provider implements: each declared root's files on its host. Read
 * only by this plugin — a consumer holds the {@link FileRoot} its own plugin
 * declared (`data-files/no-direct-store`).
 */
export interface DataFilesImpl {
  root(spec: FileRootSpec): FileRootStore;
}

/**
 * The files app-owned data dirs hold, on whatever host runs: the computer's
 * disk on the desktop (`data-files#machine`), memory in a browser host
 * (`data-files/plugins/memory`).
 */
export const DataFiles = defineHostService<DataFilesImpl>("data-files.store");
