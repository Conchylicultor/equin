import { serveValue } from "@plugins/network/plugins/live/machine";
import { attemptWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { watchHostPath } from "@plugins/infra/plugins/host-fs/machine";
import {
  codeFile,
  codeFileDiff,
  type CodeFile,
  type CodeFileDiff,
} from "@plugins/code-explorer/plugins/code-api/core";
import { resolveInsideRoot } from "../../server/internal/contained-path";
import {
  getFileContent,
  getFileContentAtRef,
  type FileReadResult,
} from "./get-file-content";
import { getFileDiff } from "./get-file-diff";
import { isAllowedRef, resolveRef } from "../../server/internal/resolve-ref";
import { workspaceFileSignature } from "./workspace-bytes";
import {
  workspaceAttemptIds,
  workspaceRootFrom,
  type WorkspaceRoot,
} from "../../server/internal/resolve-worktree-path";
import {
  checkoutRootOf,
  gitDirChange,
  noWatch,
  pinnedRefs,
  refChange,
  watchCheckout,
  workspaceRootOf,
  type WorkspaceFile,
} from "./workspace";
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Call `onChange` whenever what a read of `file` under `root` answers may
 * have changed, until the returned stop runs. On disk now: a watch of the
 * file's own entry (host-fs's `watchHostPath` — any workspace kind, riding
 * the checkout's watch when one is open). As of a named ref (`HEAD`,
 * `main`): HEAD and the refs in the checkout's git dir, `refs/heads/main`
 * included for `main` — not the index, which `ref:path` never reads. As of a
 * sha, a tuple the read refuses, or no workspace (`root` null): nothing —
 * its answer cannot move until the root does, which re-points the watch (the
 * value follows the attempt row). `onChange` runs once the watch is open, so
 * a change between the load and the watch — a re-pointed one's — is heard.
 */
export async function watchWorkspaceFile(
  file: WorkspaceFile,
  root: WorkspaceRoot | null,
  onChange: () => void,
): Promise<() => void> {
  const { ref } = file;
  if (root === null) return noWatch;
  if (ref !== undefined && pinnedRefs([ref])) return noWatch;
  let stop: () => void;
  if (ref !== undefined) {
    if (!root.git) return noWatch;
    stop = await watchCheckout(
      root.path,
      { main: ref === "main", hears: refChange },
      onChange,
    );
  } else {
    const abs = resolveInsideRoot(root.path, file.path);
    if (abs === null) return noWatch;
    stop = await watchHostPath(asUserPath(abs), onChange);
  }
  onChange();
  return stop;
}

/** The text a `code.file` tuple reads under its workspace's `root`, or its refusal. */
export async function loadCodeFile(
  {
    worktree,
    path,
    ref,
  }: {
    worktree: string;
    path: string;
    ref?: string;
  },
  root: WorkspaceRoot | null,
): Promise<CodeFile> {
  let result: FileReadResult;
  if (ref !== undefined) {
    // As of a revision: a git read, so the workspace must be a checkout.
    const checkout = checkoutRootOf(root, worktree, codeFile.refuse);
    if (!isAllowedRef(ref)) {
      throw codeFile.refuse(
        "invalid-ref",
        `${JSON.stringify(ref)} is not a ref`,
      );
    }
    result = await getFileContentAtRef(
      checkout,
      path,
      await resolveRef(checkout, ref),
    );
  } else {
    // On disk now: any workspace kind.
    result = await getFileContent(
      workspaceRootOf(root, worktree, codeFile.refuse),
      path,
    );
  }
  const where = `${worktree}:${path}${ref === undefined ? "" : ` at ${ref}`}`;
  switch (result.kind) {
    case "ok":
      return { content: result.content };
    case "invalid-path":
      throw codeFile.refuse(
        "invalid-path",
        `${JSON.stringify(path)} is not a path inside ${worktree}`,
      );
    case "not-found":
      throw codeFile.refuse("missing", `No such file: ${where}`);
    case "too-large":
      throw codeFile.refuse(
        "too-large",
        `${where} is ${result.size} bytes, over the text limit`,
      );
    case "binary":
      throw codeFile.refuse("binary", `${where} is a binary file`);
    case "denied":
      throw codeFile.refuse("denied", `Permission denied: ${where}`);
    case "unreadable-archive":
      throw codeFile.refuse(
        "unreadable-archive",
        `${where} cannot be read from its archive (${result.reason})`,
      );
  }
}

/**
 * A workspace file's text, on demand: re-read over HTTP by each tab after a
 * watch invalidates it (see {@link watchWorkspaceFile}). Throttled — a commit
 * or a rebase writes many refs at once. The ETag is the file's revision
 * (`workspaceFileSignature`, probed before the read, over the root read in
 * the same call), so an invalidation that moved nothing costs a 304.
 */
export const codeFileServed = serveValue(codeFile, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ worktree }) => ({
      ids: workspaceAttemptIds(worktree),
    })),
  }),
  throttleMs: 500,
  loader: async (q, { followed }) =>
    loadCodeFile(q, await workspaceRootFrom(q.worktree, followed.ws)),
  revalidate: async (q, { followed }) =>
    workspaceFileSignature(
      fileOf(q),
      await workspaceRootFrom(q.worktree, followed.ws),
    ),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) =>
      watchWorkspaceFile(
        fileOf(q),
        await workspaceRootFrom(q.worktree, ws),
        () => notify(),
      ),
  },
});

/** A `code.file` tuple as the workspace file it reads. */
function fileOf({
  worktree,
  path,
  ref,
}: {
  worktree: string;
  path: string;
  ref?: string;
}): WorkspaceFile {
  return { workspace: worktree, path, ...(ref !== undefined ? { ref } : {}) };
}

/** The diff a `code.file-diff` tuple reads under its workspace's `root`, or its refusal. */
export async function loadCodeFileDiff(
  {
    worktree,
    path,
    base,
    head,
    from,
  }: {
    worktree: string;
    path: string;
    base?: string;
    head?: string;
    from?: string;
  },
  root: WorkspaceRoot | null,
): Promise<CodeFileDiff> {
  const checkout = checkoutRootOf(root, worktree, codeFileDiff.refuse);
  const result = await getFileDiff(checkout, path, base ?? "HEAD", head, from);
  if (result.kind === "ok") return { diff: result.diff };
  switch (result.reason) {
    case "invalid-path":
    case "invalid-ref":
    case "missing":
    case "too-large":
      throw codeFileDiff.refuse(
        result.reason,
        `${result.message}: ${worktree}:${path}`,
      );
    case "failed":
      throw new Error(`${result.message}: ${worktree}:${path}`);
  }
}

/**
 * Hear what can move a diff under `root`: the checkout's git dir (HEAD, the
 * index, the own branch, `main` when either side resolves it), and — for a
 * diff against the working tree — the file and its old path. A `base..head`
 * of two shas never moves; no checkout (`root` null or not git) has nothing
 * to watch until the root moves, which re-points the watch. `onChange` runs
 * once it is open (see {@link watchWorkspaceFile}).
 */
async function watchFileDiff(
  q: {
    worktree: string;
    path: string;
    base?: string;
    head?: string;
    from?: string;
  },
  root: WorkspaceRoot | null,
  onChange: () => void,
): Promise<() => void> {
  const base = q.base ?? "HEAD";
  const refs = q.head === undefined ? [base] : [base, q.head];
  if (q.head !== undefined && pinnedRefs(refs)) return noWatch;
  if (!refs.every(isAllowedRef)) return noWatch;
  if (root === null || !root.git) return noWatch;
  const checkout = root.path;
  const files = new Set<string>();
  if (q.head === undefined) {
    for (const rel of [q.path, q.from]) {
      const abs = rel === undefined ? null : resolveInsideRoot(checkout, rel);
      if (abs !== null) files.add(abs);
    }
  }
  const stop = await watchCheckout(
    checkout,
    {
      main: refs.includes("main"),
      hears: (change) => gitDirChange(change) || files.has(change.path),
    },
    onChange,
  );
  onChange();
  return stop;
}

/**
 * One file's diff, on demand: re-read over HTTP by each tab after the
 * checkout watch invalidates it. Throttled — a commit, a rebase or a save
 * burst writes many git-dir entries at once. Follows the workspace's attempt
 * row as `code.file` does.
 */
export const codeFileDiffServed = serveValue(codeFileDiff, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(attemptWorkspacesServed, ({ worktree }) => ({
      ids: workspaceAttemptIds(worktree),
    })),
  }),
  throttleMs: 500,
  loader: async (q, { followed }) =>
    loadCodeFileDiff(q, await workspaceRootFrom(q.worktree, followed.ws)),
  whileFollowing: {
    over: (followed) => followed.ws,
    start: async (q, { over: ws, notify }) =>
      watchFileDiff(q, await workspaceRootFrom(q.worktree, ws), () => notify()),
  },
});
