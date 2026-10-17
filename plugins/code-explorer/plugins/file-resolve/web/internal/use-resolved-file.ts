import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import { resolveFile } from "../../shared/endpoints";

/**
 * Where a requested path resolved to. `exact` and `resolved` carry the
 * FileRef to read it through: a file inside the worktree is a `git` ref with a
 * checkout-relative path (even when it was asked for by absolute or `~` path),
 * any other existing file a `host` ref.
 */
export type ResolvedFileState =
  | { status: "loading" }
  | { status: "exact"; file: FileRef }
  | { status: "resolved"; file: FileRef }
  | { status: "ambiguous"; matches: string[] }
  | { status: "not-found" };

export function useResolvedFile(
  worktree: string,
  path: string,
): ResolvedFileState {
  const { data, isLoading, error } = useEndpoint(
    resolveFile,
    { worktree },
    { query: { path } },
  );

  // No data for the current (worktree, path) key yet → still resolving. A
  // failed resolve is treated as "not found" (the prior cancel-flag effect did
  // the same), so any error collapses to the not-found branch.
  if (isLoading || (!data && !error)) return { status: "loading" };
  if (!data) return { status: "not-found" };

  if (data.kind === "exact") {
    return {
      status: "exact",
      file:
        data.source === "git"
          ? { source: "workspace", workspace: worktree, path: data.path }
          : { source: "host", path: data.path },
    };
  }
  if (data.kind === "resolved") {
    return data.matches.length === 1
      ? {
          status: "resolved",
          file: {
            source: "workspace",
            workspace: worktree,
            path: data.matches[0]!,
          },
        }
      : { status: "ambiguous", matches: data.matches };
  }
  return { status: "not-found" };
}
