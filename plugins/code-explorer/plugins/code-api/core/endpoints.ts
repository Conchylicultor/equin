import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * What every read of a checkout on this computer needs — a live value or an
 * endpoint (`getImageContent`), its `needsMachine`.
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

// Returns a checkout file's raw bytes (image formats only today; 415 for any
// other) — served outside implement(), so the declared query and blob response
// type the client side only: `codeImageUrl` builds the address an `<img>` reads,
// and `fetchEndpoint` reads the bytes as a Blob. Reads the computer's checkout,
// so it is the machine half's: a host without the computer answers its asset
// unavailable without a request.
export const getImageContent = defineEndpoint({
  route: "GET /api/code/:worktree/image",
  query: z.object({ path: z.string(), ref: z.string().optional() }),
  response: blob(),
  needsMachine: CODE_MACHINE,
});
