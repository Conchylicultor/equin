import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { TrashEntrySchema } from "./schemas";

// All trash entries for one source, newest-deleted first. `sourceId` comes from
// the path. The Trash UI reads the `trashEntries` live collection; this is the
// HTTP twin.
export const listTrash = defineEndpoint({
  route: "GET /api/trash/:sourceId",
  response: z.array(TrashEntrySchema),
});

// Restore a single trashed root: looks the entry up (404 if already gone — never
// a silent no-op), calls the source's `restore`, then deletes the entry row.
export const restoreTrash = defineEndpoint({
  route: "POST /api/trash/:sourceId/:entryId/restore",
  unpredicted: {
    reason: "server-decided",
    why: "the source decides which cascade roots come back, across several collections",
  },
  response: z.object({ ok: z.literal(true) }),
});

// Permanently purge a single trashed root: same lookup + 404 contract, calls the
// source's `purge`, then deletes the entry row. The domain hard-delete (and its
// FK cascades) fire here — this is the one place they are intended.
export const purgeTrash = defineEndpoint({
  route: "POST /api/trash/:sourceId/:entryId/purge",
  unpredicted: {
    reason: "server-decided",
    why: "destroy hooks run before the hard delete, so gone is a claim only the server can make",
  },
  response: z.object({ ok: z.literal(true) }),
});
