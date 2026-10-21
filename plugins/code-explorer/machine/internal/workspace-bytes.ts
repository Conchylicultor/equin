import { resolve } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { openHostFile } from "@plugins/infra/plugins/host-fs/server";
import { hostPathVersion } from "@plugins/infra/plugins/host-fs/machine";
import { resolveInsideRoot } from "../../server/internal/contained-path";
import { isAllowedRef, resolveRef } from "../../server/internal/resolve-ref";
import { loadWorkspaceRoot, type WorkspaceFile } from "./workspace";

// A local blob read serving an open read; only a wedged child reaches this,
// and it then fails as a named error (see get-file-content.ts).
const GIT_TIMEOUT_MS = 30_000;

/**
 * A workspace file's bytes, or why there are none — each failure a
 * determinate answer about the file the caller turns into its own refusal:
 *
 * - `no-workspace` / `not-a-checkout` — the workspace id names none, or a read
 *   at a ref names one that is not a git checkout;
 * - `invalid-path` / `invalid-ref` — not a relative path inside it, not a ref;
 * - `missing` / `denied` / `not-a-file` / `unreadable-archive` — the entry on
 *   disk (or at the ref: not there, or not a blob);
 * - `too-large` — over the caller's `maxBytes`, gated BEFORE the read.
 */
export type WorkspaceBytesResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "no-workspace" }
  | { kind: "not-a-checkout" }
  | { kind: "invalid-path" }
  | { kind: "invalid-ref" }
  | { kind: "missing" }
  | { kind: "denied" }
  | { kind: "not-a-file" }
  | { kind: "unreadable-archive"; reason: string }
  | { kind: "too-large"; size: number };

/**
 * The bytes of a workspace file — on disk now (any workspace kind, through
 * host-fs's one file opener) or AS OF `ref` (a checkout's blob). Resolving
 * an attempt-id workspace reads its attempt row: a live value serving
 * through it declares `workspaceRootReads`. Watch it with
 * `watchWorkspaceFile`.
 */
export async function readWorkspaceBytes(
  file: WorkspaceFile,
  maxBytes: number,
): Promise<WorkspaceBytesResult> {
  const root = await loadWorkspaceRoot(file.workspace);
  if (root === null) return { kind: "no-workspace" };
  const abs = resolveInsideRoot(root.path, file.path);
  if (abs === null) return { kind: "invalid-path" };

  if (file.ref === undefined) {
    const opened = await openHostFile(abs);
    switch (opened.kind) {
      case "ok":
        if (opened.size > maxBytes) {
          return { kind: "too-large", size: opened.size };
        }
        return { kind: "ok", bytes: await opened.read() };
      case "missing":
      case "denied":
      case "not-a-file":
        return { kind: opened.kind };
      case "unreadable-archive":
        return { kind: "unreadable-archive", reason: opened.reason };
    }
  }

  if (!root.git) return { kind: "not-a-checkout" };
  if (!isAllowedRef(file.ref)) return { kind: "invalid-ref" };
  const checkout = resolve(root.path);
  const object = `${await resolveRef(checkout, file.ref)}:${file.path}`;
  const git = (args: string[]) =>
    spawnCaptured([GIT, "--no-optional-locks", "-C", checkout, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  // Kind and size first, so a huge blob is never pulled into memory.
  const kind = await git(["cat-file", "-t", object]);
  if (kind.exitCode !== 0) return { kind: "missing" };
  if (kind.stdout.trim() !== "blob") return { kind: "not-a-file" };
  const size = await git(["cat-file", "-s", object]);
  if (size.exitCode !== 0) {
    throw new Error(`git cat-file -s ${object} failed: ${size.stderr}`);
  }
  const bytes = Number(size.stdout.trim());
  if (bytes > maxBytes) return { kind: "too-large", size: bytes };
  const blob = await git(["cat-file", "blob", object]);
  if (blob.exitCode !== 0) {
    throw new Error(`git cat-file blob ${object} failed: ${blob.stderr}`);
  }
  return { kind: "ok", bytes: blob.stdoutBytes };
}

/**
 * The revision of what a read of `file` answers — the ETag of a value serving
 * it (`revalidate`), probed before the read, so a change landing mid-read
 * leaves the tag older than the bytes and the next probe misses. Covers every
 * input the read has: the workspace's root (its attempt row), and on disk the
 * file's own stamp (host-fs's `hostPathVersion` — inode, size, modified time;
 * an archive member's archive), as of a ref the blob the ref names. A tuple
 * the read refuses tags its refusal.
 */
export async function workspaceFileSignature(
  file: WorkspaceFile,
): Promise<string> {
  const root = await loadWorkspaceRoot(file.workspace);
  if (root === null) return "no-workspace";
  const abs = resolveInsideRoot(root.path, file.path);
  if (abs === null) return "invalid-path";
  if (file.ref === undefined) {
    const { stamp } = await hostPathVersion(abs);
    return `disk:${abs}:${stamp ?? "none"}`;
  }
  if (!root.git) return "not-a-checkout";
  if (!isAllowedRef(file.ref)) return "invalid-ref";
  const checkout = resolve(root.path);
  const object = `${await resolveRef(checkout, file.ref)}:${file.path}`;
  const blob = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      checkout,
      "rev-parse",
      "--verify",
      "--quiet",
      object,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  return `ref:${checkout}:${blob.exitCode === 0 ? blob.stdout.trim() : "none"}`;
}
