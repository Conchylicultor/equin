import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { beforeAfterPairAttachmentLinksEntityRef } from "../../core";
import { _beforeAfterPairs } from "./tables";

// Pair ↔ attachment link: a pair's two PNGs are owned by its row, so the
// orphan sweep never reclaims a published image (and deleting the pair drops
// its links). Kept beside `./tables.ts`, in the drizzle-kit glob via the
// `schema-*.ts` pattern.
export const beforeAfterPairAttachments = Attachments.defineLink(
  _beforeAfterPairs,
  beforeAfterPairAttachmentLinksEntityRef,
);
// The underlying pgTable, for drizzle-kit's schema glob — only the handle goes
// in barrels.
export const _beforeAfterPairAttachmentsTable =
  beforeAfterPairAttachments.table;
