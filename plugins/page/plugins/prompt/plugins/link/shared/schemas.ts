import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// The `tasks_ext_prompt_block` row: the page and block a task was launched
// from, keyed on the task id. `server/internal/tables.ts` builds the table from
// this shape, and the collection below sends this one wire row.
export const promptBlockShape = defineExtensionShape({
  key: "taskId",
  fields: { pageId: textField(), blockId: textField({ label: "Block" }) },
  wireTimestamps: ["createdAt"],
});

// One task launched from a prompt block. `pageId`/`blockId` are the provenance
// stamped at creation; they are carried on the row so a consumer never has to
// join back to the extension table.
export const PromptTaskLinkSchema = promptBlockShape.schema;
export type PromptTaskLink = z.infer<typeof PromptTaskLinkSchema>;

// The link rows, as a live collection. It answers both questions the link is
// asked, one per read:
//
// - block side, "which tasks did THIS prompt block launch?" — the window
//   filtered on `blockId` (`useLive(promptBlockTasks, { where: { blockId } })`),
//   newest first, so a new launch always lands inside the default window of
//   50 (max 200). Only launches older than a block's 50th would drop out, and a
//   block's launches are a handful.
// - task side, "which page/block did THIS task come from?" — the `:rows` point
//   read by task id (`useLiveRow(promptBlockTasks, taskId)`), where
//   `found: false` is "not launched from a prompt block".
//
// **The row id is `taskId`, the table's primary key** (stored as `parent_id`),
// not `blockId`: the point membership intersects the ids a write touched — PK
// values — with each reader's id set, so keying on `blockId` would name ids no
// write ever reports. `blockId` is a plain filterable column instead.
//
// NOT preloaded: the block renderer and the task-detail origin section both
// mount route-scoped, so they hydrate post-mount via their sub-ack.
export const promptBlockTasks = liveCollection("prompt-block-tasks", {
  from: promptBlockShape,
  pick: ["blockId"],
  id: "taskId",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "desc"]], limit: 50 },
  maxLimit: 200,
});
