import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
// Relative sibling: this file lives INSIDE the `paths` plugin (see
// `checkout-ref.ts`).
import { worktreeArtifacts } from "./paths";

// Which checkout a namespace's data dir belongs to, written down by the CLI that
// acts as it.
//
// `~/.equin/worktrees/<ns>/` is created by whatever first writes into it —
// a check log, an op marker, a test status — and nothing recorded WHO. The
// reaper can still reclaim the namespaces it can name from elsewhere (an attempt
// row, a composition marker, a spec's `server` path), but a checkout outside all
// three — a second clone, an e2e's temp repo, a hand-made worktree — left its
// dir behind forever, and a harness had to delete its own by hand. A stamp makes
// it one more "owner is gone" case.

/** Record that `root`'s CLI is acting as `ns`. Rewritten on every op, so the file's mtime is the last use. */
export function stampCheckoutOwner(ns: Namespace, root: string): void {
  const path = worktreeArtifacts.checkoutOwner(ns);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ root: resolve(root) })}\n`);
}

export type CheckoutOwnerRead =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "stamped"; root: string; lastUsedMs: number };

/**
 * The stamp for `ns`. `malformed` is its own arm: a stamp that exists and cannot
 * be read must not read as "no owner recorded", and never as "owner gone".
 */
export function readCheckoutOwner(ns: Namespace): CheckoutOwnerRead {
  const path = worktreeArtifacts.checkoutOwner(ns);
  let text: string;
  let lastUsedMs: number;
  try {
    text = readFileSync(path, "utf8");
    lastUsedMs = statSync(path).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "malformed", reason: `unreadable (${String(code ?? err)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      kind: "malformed",
      reason: `not JSON (${(err as Error).message})`,
    };
  }
  const root = (parsed as { root?: unknown } | null)?.root;
  if (typeof root !== "string" || root === "")
    return { kind: "malformed", reason: '"root" is not a path' };
  return { kind: "stamped", root, lastUsedMs };
}
