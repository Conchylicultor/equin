import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getFileContent as getFileContentEndpoint } from "@plugins/code-explorer/plugins/code-api/core";
import { getFileContent, getFileContentAtRef } from "./get-file-content";
import { ALLOWED_REFS, resolveRef } from "./resolve-ref";
import {
  resolveWorkspacePath,
  resolveWorktreePath,
} from "./resolve-worktree-path";

export const handleFileContent = implement(getFileContentEndpoint, async ({ params, req }) => {
  const { worktree } = params;
  if (!worktree) throw new HttpError(400, "Missing worktree");

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) throw new HttpError(400, "Missing path");
  const ref = url.searchParams.get("ref");

    let result;
  if (ref) {
      // As of a revision: a git read, so the workspace must be a checkout.
      const wtPath = await resolveWorktreePath(worktree);
      if (!wtPath) throw new HttpError(404, "Not found");
    if (!ALLOWED_REFS.has(ref)) throw new HttpError(400, "Invalid ref");
    const resolvedRef = await resolveRef(wtPath, ref);
    result = await getFileContentAtRef(wtPath, path, resolvedRef);
  } else {
      // On disk now: any workspace kind.
      const root = await resolveWorkspacePath(worktree);
      if (!root) throw new HttpError(404, "Not found");
      result = await getFileContent(root, path);
  }

    switch (result.kind) {
      case "invalid-path":
        throw new HttpError(400, "Invalid path");
      case "not-found":
        throw new HttpError(404, "File not found");
      case "too-large":
        throw new HttpError(413, "File too large");
      case "binary":
        throw new HttpError(415, "Binary file");
      case "denied":
        throw new HttpError(403, "Permission denied");
      case "unreadable-archive":
        throw new HttpError(
          422,
          `Unreadable archive member (${result.reason})`,
        );
      case "ok":
        return { content: result.content };
    }
  },
);
