import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import { resolvedFile, type ResolvedFile } from "../../shared/resolved-file";

/** A failed or refused `code.resolve-file` read, as `useLive` answered it (its `refetch` included). */
export type ResolvedFileFailure = Extract<
  ResourceResult<ResolvedFile, "no-workspace">,
  { status: "error" }
>;

/**
 * Where a requested path resolved to. `exact` and `resolved` carry the
 * FileRef to read it through: a file inside the worktree is a `workspace` ref
 * with a checkout-relative path (even when it was asked for by absolute or `~`
 * path), any other existing file a `host` ref. `ambiguous` holds the best
 * candidates (at most `RESOLVE_MAX_MATCHES`) and how many matched in all.
 * `error` is a failed or refused resolution (`no-workspace`) — the read
 * itself, so its `refetch` offers a Retry —, `unavailable` a host without the
 * computer to resolve on.
 */
export type ResolvedFileState =
  | { status: "loading" }
  | { status: "exact"; file: FileRef }
  | { status: "resolved"; file: FileRef }
  | { status: "ambiguous"; matches: string[]; total: number }
  | { status: "not-found" }
  | { status: "unavailable"; message: string }
  | { status: "error"; read: ResolvedFileFailure };

/**
 * `code.resolve-file` read live (it re-resolves as files appear or go), mapped
 * onto the FileRef the file-viewer reads.
 */
export function useResolvedFile(
  worktree: string,
  path: string,
): ResolvedFileState {
  const result = useLive(resolvedFile, { worktree, path });
  switch (result.status) {
    case "loading":
      return { status: "loading" };
    case "unavailable":
      return { status: "unavailable", message: result.message };
    case "error":
      return { status: "error", read: result };
    case "ready":
      break;
  }
  const data = result.data;
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
      : { status: "ambiguous", matches: data.matches, total: data.total };
  }
  return { status: "not-found" };
}
