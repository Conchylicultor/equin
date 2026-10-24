import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { IdKinds } from "@plugins/ids/server";
import {
  serveTagTree,
  singleTagCarrier,
  TagTrees,
} from "@plugins/tag-tree/plugins/engine/server";
import {
  deletePrototype,
  prototypeTagIdKind,
  prototypeTagTree,
  restorePrototype,
  setPrototypeState,
} from "../core";
import {
  handleDeletePrototype,
  handleRestorePrototype,
  handleSetPrototypeState,
} from "./internal/handlers";
import { importStatusFilesWarmup } from "./internal/import-status-files";
import { adoptLegacyTrashWarmup } from "./internal/legacy-trash";
import {
  prototypeStatesServed,
  prototypeTagsServed,
} from "./internal/resources";
import { _prototypeState, _prototypeTags } from "./internal/tables";

export default {
  description:
    "Per-instance prototype state in the DB: the prototype_state table (pinned, Done, one tag per prototype, deletedAt) and its PATCH, the delete / restore endpoints (deleted is a field — the folder stays), the prototypes' tag tree (prototype_tags, served through the tag-tree engine; a deleted tag's prototypes move to its parent), both live collections, the one-time import of the retired host-global _status/<id>.json records into an empty table, and (main only) the adoption of the old _trash/<id>/ folders as deleted prototypes.",
  register: [importStatusFilesWarmup, adoptLegacyTrashWarmup],
  httpRoutes: {
    [setPrototypeState.route]: handleSetPrototypeState,
    [deletePrototype.route]: handleDeletePrototype,
    [restorePrototype.route]: handleRestorePrototype,
  },
  contributions: [
    IdKinds.Kind({ kind: prototypeTagIdKind }),
    ...prototypeStatesServed.declare,
    ...prototypeTagsServed.declare,
    TagTrees.Tree(
      serveTagTree(prototypeTagTree, {
        table: _prototypeTags,
        carriers: [singleTagCarrier(_prototypeState, _prototypeState.tagId)],
      }),
    ),
  ],
} satisfies ServerPluginDefinition;
