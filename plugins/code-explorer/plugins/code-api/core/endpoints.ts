import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const CodeDirEntrySchema = z.object({
  name: z.string(),
  /** `other`: a symlink, submodule or anything else that is neither. */
  kind: z.enum(["file", "dir", "other"]),
});
export type CodeDirEntry = z.infer<typeof CodeDirEntrySchema>;

// Returns a checkout file's raw bytes (image formats only today; 415 for any
// other) — served outside implement(), so the declared query and blob response
// type the client side only: `codeImageUrl` builds the address an `<img>` reads,
// and `fetchEndpoint` reads the bytes as a Blob.
export const getImageContent = defineEndpoint({
  route: "GET /api/code/:worktree/image",
  query: z.object({ path: z.string(), ref: z.string().optional() }),
  response: blob(),
});
