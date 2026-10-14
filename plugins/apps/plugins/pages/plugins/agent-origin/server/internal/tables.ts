import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { agentPageShape } from "../../shared/resources";

// `page_blocks_ext_origin`: presence = the page was created by an automated
// session (`x-singularity-origin: agent`). `source` records WHICH one, e.g.
// "e2e:copy-paste-verify" — enough to trace a stray page back to the script
// that minted it. A user-created page has no row at all; the exposed `origin`
// presence reads "user" for it (`shared/resources.ts`), so the absence is a
// value, never a hole.
export const pageBlocksOrigin = defineExtension(
  _blocks,
  "origin",
  agentPageShape,
  {
    // The nightly sweep scans by age, not by `parent_id` — the PK's implicit
    // btree covers nothing here, so the age column gets its own index.
    indexes: (t, b) => [b.index("created_at").on(t.createdAt)],
  },
);
// Re-exported so drizzle-kit discovers the underlying pgTable.
export const _pageBlocksOriginExt = pageBlocksOrigin.table;
