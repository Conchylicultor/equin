import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const RunBackupResultSchema = z.object({
  ok: z.literal(true),
  jobId: z.string(),
});
export type RunBackupResult = z.infer<typeof RunBackupResultSchema>;

export const runBackup = defineEndpoint({
  route: "POST /api/backup/run",
  unpredicted: {
    reason: "server-decided",
    why: "a backup run's outcome is decided by the filesystem and dispatch targets",
  },
  response: RunBackupResultSchema,
});
