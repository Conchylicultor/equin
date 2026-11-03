import { Attachments } from "@plugins/infra/plugins/attachments/server";
import { songAttachmentLinksEntityRef } from "../../core";
import { _songs } from "./tables";

// Song ↔ MIDI-attachment link (creates `sonata_songs_attachments`, composite PK,
// FK cascade both sides). Kept in a separate file from `./tables.ts` because the
// server-only `Attachments` import would otherwise drag postgres + db/client
// into anything reachable from the web bundle. Mirrors
// tasks-core/server/internal/schema-attachments.ts and page/image's tables.ts.
export const songAttachments = Attachments.defineLink(
  _songs,
  songAttachmentLinksEntityRef,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _songAttachmentsTable = songAttachments.table;
