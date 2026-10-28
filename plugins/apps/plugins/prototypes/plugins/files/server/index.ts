import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { IdKinds } from "@plugins/ids/server";
import {
  getPrototypeEntry,
  getPrototypeFile,
  getPrototypeVersionFile,
  listPrototypes,
  protoIdKind,
  restorePrototypeVersion,
  setPrototypePicks,
} from "../core";
import { handleList } from "./internal/handlers";
import {
  handleRestoreVersion,
  prototypeHistoryServed,
  prototypeVersionCountsServed,
} from "./internal/history";
import { handleSetPicks, prototypePicksServed } from "./internal/picks";
import { prototypesListServed } from "./internal/resources";
import {
  handlePrototypeAsset,
  handlePrototypeFile,
  handlePrototypeVersionFile,
} from "./internal/serve-file";
import {
  startPrototypesWatcher,
  stopPrototypesWatcher,
} from "./internal/watcher";

// What this plugin knows about the prototypes tree that a sibling cannot
// re-derive without duplicating it: what is in it, and when it changed.
// `onPrototypesChanged` in particular is what keeps a second subscription off
// the same tree; `settlePrototypesWatcher` is when it has caught up with a
// write (a fixture writer's, before it relies on the adopted histories). WHERE the tree is is not exported from here: the app declares
// its data dir and its file root at its root (`@plugins/apps/plugins/prototypes/data-dirs`,
// `@plugins/apps/plugins/prototypes/server`'s `prototypesFiles`).
export {
  listPrototypeMetas,
  listPrototypeNames,
  readPrototypeMeta,
  readPrototypeTitle,
} from "./internal/list";
export {
  onPrototypesChanged,
  settlePrototypesWatcher,
} from "./internal/watcher";
// The version store's one write a sibling needs: the `checkpoints` plugin
// records a version at the end of every agent turn that touched a prototype.
export { checkpointPrototype } from "./internal/history";
// Whether a prototype folder exists — the `state` plugin's 404 for a write
// about a prototype that is not there.
export { prototypeExists } from "./internal/paths";
// The version store's contract, provided per host: git repos by this plugin's
// machine half, snapshots over the file root by `files/snapshot-history`.
export {
  HISTORY_DIR_NAME,
  LATEST_STAMP_FILE,
  LatestStampSchema,
  PrototypeHistoryStore,
  assertFlatFileName,
  assertPrototypeId,
  assertVersionSha,
  historyDirOf,
  historyStampOf,
} from "./internal/history-store";
export type {
  CheckpointInput,
  CheckpointResult,
  EnsureHistoryResult,
  HistoryRead,
  HistoryStore,
  RestoreResult,
  VersionEntry,
  VersionFileRead,
} from "./internal/history-store";
// How every provider words a checkpoint, so a git version and a snapshot one
// read the same.
export { checkpointMessage } from "../shared/history/message";

export default {
  // Names the declaration rather than spelling the path: a plugin description is
  // read TEXTUALLY by the docs pipeline, which rejects anything but a static
  // string literal — so this one field cannot interpolate
  // PROTOTYPES_DIR_DISPLAY the way every other message here does.
  description:
    "Serves the prototypes tree (the app's prototypesFiles root over the `apps/prototypes` data dir — the computer's disk on the desktop, memory in a browser host) on every host: the raw files and recorded versions' files (picked options ?<option>=<value> stamped onto a document's <html>: data-* for a choice, a --<name> custom property for a color), the list + version live-state resources, a watch over the tree that auto-reloads open iframes on a real edit, the user's option picks as one shared record per prototype under _picks/ (the prototypes.picks resource and its PUT, undone for automated sessions through the root's ledger), and each prototype's version history through the PrototypeHistoryStore host service (the per-prototype history resource, restore, and checkpointPrototype). Minting a prototype from the checkout's template is its machine/ half's.",
  portable: true,
  httpRoutes: {
    [listPrototypes.route]: handleList,
    [restorePrototypeVersion.route]: handleRestoreVersion,
    [setPrototypePicks.route]: handleSetPicks,
    [getPrototypeEntry.route]: rawEndpointHandler(
      getPrototypeEntry,
      handlePrototypeFile,
    ),
    [getPrototypeFile.route]: rawEndpointHandler(
      getPrototypeFile,
      handlePrototypeAsset,
    ),
    [getPrototypeVersionFile.route]: rawEndpointHandler(
      getPrototypeVersionFile,
      handlePrototypeVersionFile,
    ),
  },
  contributions: [
    IdKinds.Kind({ kind: protoIdKind }),
    ...prototypesListServed.declare,
    ...prototypeHistoryServed.declare,
    ...prototypeVersionCountsServed.declare,
    ...prototypePicksServed.declare,
  ],
  onReady: async () => {
    await startPrototypesWatcher();
  },
  onShutdown: async () => {
    await stopPrototypesWatcher();
  },
} satisfies ServerPluginDefinition;
