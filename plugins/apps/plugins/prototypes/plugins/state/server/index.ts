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
import {
  prototypeStatesServed,
  prototypeTagsServed,
} from "./internal/resources";
import { _prototypeState, _prototypeTags } from "./internal/tables";

// The two tables, for a seed that writes a host's starting rows (the demo's).
export { _prototypeState, _prototypeTags } from "./internal/tables";

export default {
  description:
    "Per-instance prototype state in the DB: the prototype_state table (pinned, Done, one tag per prototype, deletedAt) and its PATCH, the delete / restore endpoints (deleted is a field — the folder stays), the prototypes' tag tree (prototype_tags, served through the tag-tree engine; a deleted tag's prototypes move to its parent) and both live collections, on every host. The adoption of the old _trash/<id>/ folders is the machine/ half's.",
  portable: true,
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
