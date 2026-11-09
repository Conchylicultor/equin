import { z } from "zod";

/**
 * What every read of a checkout on this computer needs — a live value or an
 * endpoint, its `needsMachine`.
 */
export const CODE_MACHINE = {
  feature: "Reading this computer's checkouts",
} as const;

export const CodeDirEntrySchema = z.object({
  name: z.string(),
  /** `other`: a symlink, submodule or anything else that is neither. */
  kind: z.enum(["file", "dir", "other"]),
});
export type CodeDirEntry = z.infer<typeof CodeDirEntrySchema>;
