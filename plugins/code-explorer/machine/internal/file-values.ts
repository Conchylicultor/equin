import { serveValue } from "@plugins/network/plugins/live/machine";
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
  gitDirChange,
  noWatch,
  pinnedRefs,
  refChange,
  resolveCheckoutRootOf,
  resolveWorkspaceRootOf,
  watchCheckout,
  watchWorkspaceRoot,
  workspaceRootReads,
  type WorkspaceFile,
} from "./workspace";

/**
 * Call `onChange` whenever what a read of `file` answers may have changed,
 * until the returned stop runs. On disk now: a watch of the file's own entry
 * (host-fs's `watchHostPath` — any workspace kind, riding the checkout's watch
 * when one is open). As of a named ref (`HEAD`, `main`): HEAD and the refs
 * in the checkout's git dir, `refs/heads/main` included for `main` — not the
 * index, which `ref:path` never reads. As of a sha, or a tuple the read
 * refuses: nothing — its answer cannot move. A workspace whose root is not
 * there yet is watched once a load sees it (`watchWorkspaceRoot`).
 */
export async function watchWorkspaceFile(
  file: WorkspaceFile,
  onChange: () => void,
): Promise<() => void> {
  const { ref } = file;
  if (ref !== undefined && pinnedRefs([ref])) return noWatch;
  return watchWorkspaceRoot(file.workspace, onChange, async (root) => {
    if (ref !== undefined) {
      if (!root.git) return noWatch;
      return watchCheckout(
        root.path,
        { main: ref === "main", hears: refChange },
        onChange,
      );
    }
    const abs = resolveInsideRoot(root.path, file.path);
    if (abs === null) return noWatch;
    return watchHostPath(abs, onChange);
  });
}

/** The text a `code.file` tuple reads, or its refusal. */
export async function loadCodeFile({
  worktree,
  path,
  ref,
}: {
  worktree: string;
  path: string;
  ref?: string;
}): Promise<CodeFile> {
  let result: FileReadResult;
  if (ref !== undefined) {
    // As of a revision: a git read, so the workspace must be a checkout.
    const root = await resolveCheckoutRootOf(worktree, codeFile.refuse);
    if (!isAllowedRef(ref)) {
      throw codeFile.refuse(
        "invalid-ref",
        `${JSON.stringify(ref)} is not a ref`,
      );
    }
    result = await getFileContentAtRef(root, path, await resolveRef(root, ref));
  } else {
    // On disk now: any workspace kind.
    const root = await resolveWorkspaceRootOf(worktree, codeFile.refuse);
    result = await getFileContent(root, path);
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
 * (`workspaceFileSignature`, probed before the read), so an invalidation that
 * moved nothing (a write to the attempts table) costs a 304.
 */
export const codeFileServed = serveValue(codeFile, {
  source: "external",
  changes: "notified",
  reads: workspaceRootReads,
  throttleMs: 500,
  revalidate: ({ worktree, path, ref }) =>
    workspaceFileSignature({
      workspace: worktree,
      path,
      ...(ref !== undefined ? { ref } : {}),
    }),
  loader: loadCodeFile,
  whileSubscribed: ({ worktree, path, ref }, notify) =>
    watchWorkspaceFile(
      { workspace: worktree, path, ...(ref !== undefined ? { ref } : {}) },
      () => notify(),
    ),
});

/** The diff a `code.file-diff` tuple reads, or its refusal. */
export async function loadCodeFileDiff({
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
}): Promise<CodeFileDiff> {
  const root = await resolveCheckoutRootOf(worktree, codeFileDiff.refuse);
  const result = await getFileDiff(root, path, base ?? "HEAD", head, from);
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
 * Hear what can move a diff: the checkout's git dir (HEAD, the index, the
 * own branch, `main` when either side resolves it), and — for a diff against
 * the working tree — the file and its old path. A `base..head` of two shas
 * never moves.
 */
async function watchFileDiff(
  q: {
    worktree: string;
    path: string;
    base?: string;
    head?: string;
    from?: string;
  },
  onChange: () => void,
): Promise<() => void> {
  const base = q.base ?? "HEAD";
  const refs = q.head === undefined ? [base] : [base, q.head];
  if (q.head !== undefined && pinnedRefs(refs)) return noWatch;
  if (!refs.every(isAllowedRef)) return noWatch;
  return watchWorkspaceRoot(q.worktree, onChange, async (root) => {
    if (!root.git) return noWatch;
    const checkout = root.path;
    const files = new Set<string>();
    if (q.head === undefined) {
      for (const rel of [q.path, q.from]) {
        const abs = rel === undefined ? null : resolveInsideRoot(checkout, rel);
        if (abs !== null) files.add(abs);
      }
    }
    return watchCheckout(
      checkout,
      {
        main: refs.includes("main"),
        hears: (change) => gitDirChange(change) || files.has(change.path),
      },
      onChange,
    );
  });
}

/**
 * One file's diff, on demand: re-read over HTTP by each tab after the
 * checkout watch invalidates it. Throttled — a commit, a rebase or a save
 * burst writes many git-dir entries at once.
 */
export const codeFileDiffServed = serveValue(codeFileDiff, {
  source: "external",
  changes: "notified",
  reads: workspaceRootReads,
  throttleMs: 500,
  loader: loadCodeFileDiff,
  whileSubscribed: (q, notify) => watchFileDiff(q, () => notify()),
});
