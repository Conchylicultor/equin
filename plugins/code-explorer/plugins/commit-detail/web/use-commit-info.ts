import type { CommitRow } from "@plugins/primitives/plugins/commit-list/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { commitInfo } from "@plugins/code-explorer/plugins/code-api/core";

/**
 * `not-found` and `error` are separate arms on purpose: the server refusing
 * the read as `missing` ("this sha names no commit in that repository") is a
 * determinate fact about the repository, while any other failure is an absence
 * of an answer. Folding the second into the first would let a dead backend read
 * as "that commit doesn't exist". `unavailable`: the read needs the computer
 * (git, `needsMachine`) and this subtree has none (the demo) — nothing is asked.
 */
export type CommitInfoState =
  | { kind: "loading" }
  | { kind: "found"; commit: CommitRow }
  | { kind: "not-found"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * One commit's metadata, read live from `code.commit-info` — immutable per
 * `(worktree, sha)`, so every consumer of a tuple shares one read.
 */
export function useCommitInfo(worktree: string, sha: string): CommitInfoState {
  const result = useLive(commitInfo, { worktree, sha });
  switch (result.status) {
    case "loading":
      return { kind: "loading" };
    case "unavailable":
      return { kind: "unavailable", message: result.message };
    case "error":
      return result.error.kind === "refused" && result.error.code === "missing"
        ? { kind: "not-found", reason: result.error.message }
        : { kind: "error", message: result.error.message };
    case "ready":
      return { kind: "found", commit: result.data };
  }
}
