import { Attachments } from "@plugins/infra/plugins/attachments/server";
import {
  taskAttachmentLinksEntityRef,
  conversationAttachmentLinksEntityRef,
} from "../../core";
import { _conversations, _tasks } from "./tables";

// Task ↔ attachment link. Kept in a separate file from `./schema.ts` because
// that file is transitively reachable from `@plugins/tasks/plugins/tasks-core/core` (which
// web code imports); pulling `@plugins/infra/plugins/attachments/server` into it would drag
// postgres + db/client into the browser bundle. This file is included in the
// drizzle-kit glob via the `schema*.ts` pattern in SCHEMA_GLOBS
// (`plugins/database/plugins/migrations/core/internal/schema-glob-patterns.ts`).
export const taskAttachments = Attachments.defineLink(
  _tasks,
  taskAttachmentLinksEntityRef,
);
export const conversationAttachments = Attachments.defineLink(
  _conversations,
  conversationAttachmentLinksEntityRef,
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
// The leading `_` and the `internal/` location keep cross-plugin imports
// impossible — only the handle is barrel-exported.
export const _taskAttachmentsTable = taskAttachments.table;
export const _conversationAttachmentsTable = conversationAttachments.table;
