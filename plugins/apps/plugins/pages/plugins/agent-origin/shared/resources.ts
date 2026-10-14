import type { z } from "zod";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";

// One row per agent-created page, in the `page_blocks_ext_origin`
// entity-extension table that `server/internal/tables.ts` builds from this
// shape. `source` is the script that minted it ("e2e:copy-paste-verify");
// `createdAt` is the sweep's age column.
//
// It EXPOSES its presence to every list whose rows are blocks (`exposes` — the
// pages sidebar today): `origin`, `agent` where the page has a row and `user`
// where it has none — never null, so every page lands in exactly one of the
// sidebar's Private / Scratch sections (`origin is user` / `origin is agent`,
// authored in the sidebar's config). The options are labelled after those
// sections.
export const agentPageShape = defineExtensionShape({
  key: "blockId",
  fields: { source: textField() },
  wireTimestamps: ["createdAt"],
  exposes: {
    parent: pagesEntityRef,
    name: "origin",
    presence: {
      id: "origin",
      label: "Origin",
      values: { present: "agent", absent: "user" },
      options: { user: { label: "Private" }, agent: { label: "Scratch" } },
    },
  },
});
export const AgentPageRowSchema = agentPageShape.schema;
export type AgentPageRow = z.infer<typeof AgentPageRowSchema>;
