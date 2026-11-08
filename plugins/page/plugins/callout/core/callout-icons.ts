import { z } from "zod";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";

// The live blocks of one type, each its id and payload — scoped by `type`
// (`all: { by }`) so a reader asks about ONE type's rows: the saved-icon
// source follows `{ where: { type: "callout" } }`. Served over the
// `page_blocks` table (`../server/internal/saved-icons.ts`), the change feed
// carries `type` as a key, so a write to any other block reaches no
// follower before a load, and the column gate skips a callout write that
// leaves `type` and `data` (its icon and colour) as they were. Read only on
// the server; no tab subscribes it.
export const blocksByType = liveCollection("page.blocks-by-type", {
  from: pagesEntityRef,
  baseExposures: false,
  carry: {
    pick: ["id", "type"],
    fields: {
      data: jsonField<unknown>({ schema: z.unknown(), default: {} }),
    },
  },
  id: "id",
  all: {
    by: ["type"],
    orderBy: [["id", "asc"]],
    unbounded: {
      reason:
        "one block type's live blocks, followed for the callouts only — a page holds a handful of callouts",
      // Measured on main, 2026-11-08: 1 live callout.
      budget: 500,
    },
  },
});
