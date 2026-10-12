import { z } from "zod";
import { blob, defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { EditedFileSchema } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";

export const getFileContent = defineEndpoint({
  route: "GET /api/code/:worktree/file",
  query: z.object({
    path: z.string(),
    ref: z.string().optional(),
  }),
  response: z.object({ content: z.string() }),
});

export const getFileDiff = defineEndpoint({
  route: "GET /api/code/:worktree/diff",
  query: z.object({
    path: z.string(),
    base: z.string().optional(),
    head: z.string().optional(),
    from: z.string().optional(),
  }),
  response: z.object({ diff: z.string() }),
});

export const CodeDirEntrySchema = z.object({
  name: z.string(),
  /** `other`: a symlink, submodule or anything else that is neither. */
  kind: z.enum(["file", "dir", "other"]),
});
export type CodeDirEntry = z.infer<typeof CodeDirEntrySchema>;

/**
 * One directory of a checkout: as it is on disk, or AS OF `ref` (from git's
 * tree). `dir` is checkout-relative; `""` is the checkout root. A directory
 * that does not exist (or is not one) is the `missing` answer, not an error.
 */
export const listCodeDir = defineEndpoint({
  route: "GET /api/code/:worktree/list",
  query: z.object({
    dir: z.string(),
    ref: z.string().optional(),
  }),
  response: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ok"),
      /** Sorted by name. */
      entries: z.array(CodeDirEntrySchema),
    }),
    z.object({ kind: z.literal("missing") }),
  ]),
});

// Returns a checkout file's raw bytes (image formats only today; 415 for any
// other) — served outside implement(), so the declared query and blob response
// type the client side only: `codeImageUrl` builds the address an `<img>` reads,
// and `fetchEndpoint` reads the bytes as a Blob.
export const getImageContent = defineEndpoint({
  route: "GET /api/code/:worktree/image",
  query: z.object({ path: z.string(), ref: z.string().optional() }),
  response: blob(),
});

export const getPushFiles = defineEndpoint({
  route: "GET /api/code/:worktree/push",
  query: z.object({ pushId: z.string() }),
  response: z.object({
    files: z.array(EditedFileSchema),
    baseSha: z.string(),
    headSha: z.string(),
  }),
});
