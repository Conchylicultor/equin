import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { VersionSchema } from "./schemas";

// Version metadata for one entity, newest first. No snapshot blobs — the
// timeline is cheap to list. `sourceId`/`entityId` come from the path. The app
// reads the timeline live (`historyVersions`); this request/response form stays
// only for the pages history e2e script (`crdt-restore-verify.ts`), which reads
// it over plain HTTP.
export const listVersions = defineEndpoint({
  route: "GET /api/history/:sourceId/:entityId/versions",
  response: z.array(VersionSchema),
});

// Reversible replace: snapshot current state as a "Before restore" undo point,
// then hand the chosen version's snapshot to the source's `restore`.
export const restoreVersion = defineEndpoint({
  route: "POST /api/history/:sourceId/:entityId/versions/:versionId/restore",
  response: z.object({ ok: z.literal(true) }),
});
