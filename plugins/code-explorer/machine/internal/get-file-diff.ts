import { resolve, sep } from "node:path";
import { isAllowedRef } from "../../server/internal/resolve-ref";
import { tryRunGit } from "@plugins/primitives/plugins/commit-list/server";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Why a diff has no answer: a malformed path or ref, a file that is not there,
 * a diff past {@link MAX_BYTES} — each a determinate answer about the question
 * (the HTTP route's 400 / 404 / 413, the live value's refusal) — or `failed`,
 * a git failure (500, a loader error).
 */
export type FileDiffFailure =
  "invalid-path" | "invalid-ref" | "missing" | "too-large" | "failed";

export type FileDiffResult =
  | { kind: "ok"; diff: string }
  | {
      kind: "error";
      reason: FileDiffFailure;
      status: number;
      message: string;
    };

function isPathInside(root: string, target: string): boolean {
  const rootNorm = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootNorm);
}

export async function getFileDiff(
  worktreePath: string,
  relPath: string,
  base: string = "HEAD",
  head?: string,
  fromPath?: string,
): Promise<FileDiffResult> {
  if (!relPath || relPath.includes("\0")) {
    return {
      kind: "error",
      reason: "invalid-path",
      status: 400,
      message: "Invalid path",
    };
  }
  if (fromPath !== undefined && (fromPath === "" || fromPath.includes("\0"))) {
    return {
      kind: "error",
      reason: "invalid-path",
      status: 400,
      message: "Invalid from",
    };
  }
  if (!isAllowedRef(base)) {
    return {
      kind: "error",
      reason: "invalid-ref",
      status: 400,
      message: "Invalid base",
    };
  }
  if (head !== undefined && !isAllowedRef(head)) {
    return {
      kind: "error",
      reason: "invalid-ref",
      status: 400,
      message: "Invalid head",
    };
  }

  const absRoot = resolve(worktreePath);
  const absTarget = resolve(absRoot, relPath);
  if (!isPathInside(absRoot, absTarget)) {
    return {
      kind: "error",
      reason: "invalid-path",
      status: 400,
      message: "Invalid path",
    };
  }
  if (fromPath !== undefined) {
    const absFrom = resolve(absRoot, fromPath);
    if (!isPathInside(absRoot, absFrom)) {
      return {
        kind: "error",
        reason: "invalid-path",
        status: 400,
        message: "Invalid from",
      };
    }
  }

  // Resolving "main" to the merge-base is a probe: `git merge-base` exits 1 when
  // the branches share no common ancestor — a legit "no merge-base" case where
  // falling back to the literal "main" ref is correct. Any OTHER non-zero exit is
  // a real git failure and must surface as an error, not silently become "main".
  let resolvedBase = base;
  if (base === "main") {
    const mb = await tryRunGit(["merge-base", "main", "HEAD"], absRoot);
    if (mb.ok) {
      resolvedBase = mb.stdout.trim() || base;
    } else if (mb.exitCode !== 1) {
      return {
        kind: "error",
        reason: "failed",
        status: 500,
        message: "git merge-base failed",
      };
    }
  }

  // Range diff (commit-to-commit). Untracked / working-tree handling does not
  // apply — both sides are real refs. -M / -C let git emit a unified rename
  // diff when both old and new paths are passed.
  if (head !== undefined) {
    const pathArgs =
      fromPath !== undefined ? ["--", fromPath, relPath] : ["--", relPath];
    const res = await tryRunGit(
      ["diff", "--no-color", "-M", "-C", resolvedBase, head, ...pathArgs],
      absRoot,
    );
    if (!res.ok) {
      return {
        kind: "error",
        reason: "failed",
        status: 500,
        message: "git diff failed",
      };
    }
    if (res.stdout.length > MAX_BYTES) {
      return {
        kind: "error",
        reason: "too-large",
        status: 413,
        message: "Diff too large",
      };
    }
    return { kind: "ok", diff: res.stdout };
  }

  const status = await tryRunGit(
    ["status", "--porcelain", "--", relPath],
    absRoot,
  );
  if (!status.ok) {
    return {
      kind: "error",
      reason: "failed",
      status: 500,
      message: "git status failed",
    };
  }

  const statusLine = status.stdout.split("\n").find((l) => l.length > 0);
  const isUntracked = statusLine?.startsWith("??") ?? false;

  if (!statusLine && resolvedBase === "HEAD") {
    const file = Bun.file(absTarget);
    if (!(await file.exists())) {
      return {
        kind: "error",
        reason: "missing",
        status: 404,
        message: "File not found",
      };
    }
    return { kind: "ok", diff: "" };
  }

  let diff: string;
  if (isUntracked) {
    // `git diff --no-index` is an exit-code-as-signal command: exit 1 means "the
    // files differ" and the diff is on stdout — NOT a failure. Only exit >1 is a
    // real error.
    const res = await tryRunGit(
      ["diff", "--no-color", "--no-index", "--", "/dev/null", relPath],
      absRoot,
    );
    if (!res.ok && res.exitCode !== 1) {
      return {
        kind: "error",
        reason: "failed",
        status: 500,
        message: "git diff failed",
      };
    }
    diff = res.stdout;
  } else {
    const res = await tryRunGit(
      [
        "diff",
        "--no-color",
        "-M",
        "-C",
        resolvedBase,
        "--",
        ...(fromPath !== undefined ? [fromPath, relPath] : [relPath]),
      ],
      absRoot,
    );
    if (!res.ok) {
      return {
        kind: "error",
        reason: "failed",
        status: 500,
        message: "git diff failed",
      };
    }
    diff = res.stdout;
  }

  if (diff.length > MAX_BYTES) {
    return {
      kind: "error",
      reason: "too-large",
      status: 413,
      message: "Diff too large",
    };
  }
  return { kind: "ok", diff };
}
