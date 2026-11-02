import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { attachmentsEntityRef } from "../../core";

// Attachments are bytes on disk referenced by UUID. Ownership is tracked in
// per-consumer link tables declared via `Attachments.defineLink(ownerTable)`
// — see `./define-link.ts`. A row in this table survives as long as any
// registered link references it; the orphan sweep collects unreferenced rows
// past a TTL (covers the upload→link race and owner-deletion cascades alike).
const attachments = defineEntity(attachmentsEntityRef, {
  primaryKey: "id",
  columns: { createdAt: { default: defaultNow() } },
});
export const _attachments = attachments.table;

// Timed holds keeping an attachment alive while something the server cannot
// see still references it — an unsent draft, which lives in the browser's
// storage. `holder` names the draft (per browser); the holder re-asserts its
// set on every change and before `expiresAt`, which mirrors the draft's own
// TTL (null: the draft never expires). The orphan sweep skips an attachment
// with a live hold, and reclaims expired holds.
export const _attachmentHolds = pgTable(
  "attachment_holds",
  {
    holder: text("holder").notNull(),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => _attachments.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.holder, t.attachmentId] })],
);
