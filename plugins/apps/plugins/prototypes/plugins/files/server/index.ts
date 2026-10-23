import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
  createPrototype,
  deletePrototype,
  listPrototypes,
  PROTOTYPE_ASSET_ROUTE,
  PROTOTYPE_FILE_ROUTE,
  PROTOTYPE_VERSION_FILE_ROUTE,
  protoIdKind,
  restorePrototypeVersion,
  setPrototypePicks,
  setPrototypeStatus,
} from "../core";
import {
  handleCreate,
  handleDelete,
  handleList,
  handlePrototypeAsset,
  handlePrototypeFile,
} from "./internal/handlers";
import {
  handlePrototypeVersionFile,
  handleRestoreVersion,
  prototypeHistoryServed,
  prototypeVersionCountsServed,
} from "./internal/history";
import { handleSetPicks, prototypePicksServed } from "./internal/picks";
import { handleSetStatus, prototypeStatusesServed } from "./internal/status";
import { prototypesListServed } from "./internal/resources";
import {
  prototypesTreeWatcher,
  startPrototypesWatcher,
  stopPrototypesWatcher,
} from "./internal/watcher";

// What this plugin knows about the prototypes tree that a sibling cannot
// re-derive without duplicating it: what is in it, and when it changed.
// `onPrototypesChanged` in particular is what keeps a second file watcher off
// the same directory. WHERE the tree is is not exported from here: the app
// declares its one data dir at its root (`@plugins/apps/plugins/prototypes/data-dirs`),
// and a sibling imports `prototypesDir` from there — re-exporting it through
// this barrel would be proxying another plugin's symbol.
export { listPrototypeMetas, readPrototypeTitle } from "./internal/list";
export { onPrototypesChanged } from "./internal/watcher";
// The version store's one write a sibling needs: the `checkpoints` plugin
// records a version at the end of every agent turn that touched a prototype.
export { checkpointPrototype } from "./internal/history";

export default {
  // Names the declaration rather than spelling the path: a plugin description is
  // read TEXTUALLY by the docs pipeline, which rejects anything but a static
  // string literal — so this one field cannot interpolate
  // PROTOTYPES_DIR_DISPLAY the way every other message here does.
  description:
    "Serves raw prototype files from the host-global prototypes data dir (the `apps/prototypes` declaration — shared by every worktree and main, so a mock is visible without a build and without being committed), mints new prototypes into it from the running checkout's prototypes/_template/, deletes one by moving its folder into _trash/ (refused for automated sessions), declares the list + version live-state resources, watches the dir to auto-reload open iframes on edit, stamps a document's picked options (?<option>=<value>) onto its <html> (data-* for a choice, a --<name> custom property for a color), stores the user's option picks as one shared record per prototype under _picks/ (the prototypes.picks resource and its PUT, undone for automated sessions through the agent-write ledger), stores whether the user marked each prototype Done or pinned it as one shared record under _status/ (the prototypes.statuses resource and its PUT, undone the same way), and keeps each prototype's version history (a private git repo per prototype under _history/: the per-prototype history resource, a version's files, restore, and checkpointPrototype).",
  httpRoutes: {
    [listPrototypes.route]: handleList,
    [createPrototype.route]: handleCreate,
    [deletePrototype.route]: handleDelete,
    [PROTOTYPE_FILE_ROUTE]: handlePrototypeFile,
    [PROTOTYPE_ASSET_ROUTE]: handlePrototypeAsset,
    [PROTOTYPE_VERSION_FILE_ROUTE]: handlePrototypeVersionFile,
    [restorePrototypeVersion.route]: handleRestoreVersion,
    [setPrototypePicks.route]: handleSetPicks,
    [setPrototypeStatus.route]: handleSetStatus,
  },
  contributions: [
    IdKinds.Kind({ kind: protoIdKind }),
    ...prototypesListServed.declare,
    ...prototypeHistoryServed.declare,
    ...prototypeVersionCountsServed.declare,
    ...prototypePicksServed.declare,
    ...prototypeStatusesServed.declare,
  ],
  register: [prototypesTreeWatcher],
  onReady: async () => {
    await startPrototypesWatcher();
  },
  onShutdown: async () => {
    await stopPrototypesWatcher();
  },
} satisfies ServerPluginDefinition;
