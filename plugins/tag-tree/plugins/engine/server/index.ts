import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  createTag,
  createTagPath,
  deleteTag,
  moveTag,
  updateTag,
} from "../core";
import {
  handleCreateTag,
  handleCreateTagPath,
  handleDeleteTag,
  handleMoveTag,
  handleUpdateTag,
} from "./internal/handlers";

export { defineTagTreeTable } from "./internal/table";
export type {
  TagTreeColumnsMeta,
  TagTreeTable,
  TagTreeTableMeta,
} from "./internal/table";
export { serveTagTree, singleTagCarrier, TagTrees } from "./internal/serve";
export type {
  ServedTagTree,
  TagCarrier,
  TagTreeTableHandle,
  TagTreeTx,
} from "./internal/serve";

export default {
  portable: true,
  description:
    "Tag-tree engine (server): defineTagTreeTable builds a tree's table from its ref, serveTagTree + the TagTrees.Tree contribution register a tree with its carriers, and the ONE /api/tag-trees/:tree endpoint set writes any registered tree under a table lock — create (unique sibling names, appended rank), create path, update, move (positional intent, cycles refused) and delete (children lifted to the parent at the tag's position, carriers rewritten).",
  httpRoutes: {
    [createTag.route]: handleCreateTag,
    [createTagPath.route]: handleCreateTagPath,
    [updateTag.route]: handleUpdateTag,
    [moveTag.route]: handleMoveTag,
    [deleteTag.route]: handleDeleteTag,
  },
} satisfies ServerPluginDefinition;
