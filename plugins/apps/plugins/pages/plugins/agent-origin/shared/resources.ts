import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// One row per agent-created page, in the `page_blocks_ext_origin`
// entity-extension table that `server/internal/tables.ts` builds from this
// shape. `source` is the script that minted it ("e2e:copy-paste-verify");
// `createdAt` is the sweep's age column.
export const agentPageShape = defineExtensionShape({
  key: "blockId",
  fields: { source: textField() },
  wireTimestamps: ["createdAt"],
});
export const AgentPageRowSchema = agentPageShape.schema;
export type AgentPageRow = z.infer<typeof AgentPageRowSchema>;

// The marker set, as the WHOLE ordered set (`all`): the one reader,
// `OriginField` (via `useLive(agentPages, { select })`), projects an origin for
// EVERY page the `pages-sidebar` DataView splits into Private / Scratch, so it
// holds the set entire — a marked page never reads as the user's past a
// window's edge. At most one row per page, and the 24h TTL (see
// server/internal/sweep.ts) keeps the live set in single digits. The sibling
// `starred` plugin is the same shape. Rows key on `blockId` (the side-table PK
// — the marked page's id); the server half is served from the extension
// handle in `server/internal/resource.ts`.
//
// The key is `pages-origin.all`, not the old window's `pages-origin`: no
// bundle ever declared this key with another contract, so a tab on an older
// one gets `unknown-key` (a `skew` verdict) and never parses these rows.
export const agentPages = liveCollection("pages-origin.all", {
  row: AgentPageRowSchema,
  id: "blockId",
  all: {
    orderBy: [["blockId", "asc"]],
    unbounded: {
      reason:
        "at most one row per page, and the pages sidebar projects an origin for every page",
    },
  },
});
