import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import {
  asNamespace,
  isNamespace,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
// Relative sibling: this file lives INSIDE the `paths` plugin (see
// `checkout-ref.ts`).
import { worktreeArtifacts } from "./paths";

// Which backend minted an agent checkout — the namespace whose database holds
// the checkout's attempt row.
//
// Agent checkouts all land in the one shared `.claude/worktrees/`, whichever
// backend launched the agent. Main's are described by main's attempts table; a
// worktree build that launches agents (testing a launch flow) writes its
// attempt rows into its OWN forked database, so main's reaper sees a checkout
// no row names and could only wait out the 90-day floor — with a full fork DB
// beside each one. The stamp names the record's home, so the reaper can apply
// the owner-gone rule instead of guessing from a missing row.

/** Record that `minter`'s backend made the checkout `checkout`. Written once, right after the checkout exists. */
export function stampCheckoutMinter(
  checkout: Namespace,
  minter: Namespace,
): void {
  const path = worktreeArtifacts.checkoutMinter(checkout);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ minter })}\n`);
}

export type CheckoutMinterRead =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "stamped"; minter: Namespace };

/**
 * The stamp for `checkout`. `absent` is every checkout made before the stamp
 * existed, so it means "unknown", never "main"; `malformed` is its own arm so an
 * unreadable stamp can never read as either.
 */
export function readCheckoutMinter(checkout: Namespace): CheckoutMinterRead {
  const path = worktreeArtifacts.checkoutMinter(checkout);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
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
  const minter = (parsed as { minter?: unknown } | null)?.minter;
  if (typeof minter !== "string" || !isNamespace(minter))
    return { kind: "malformed", reason: '"minter" is not a namespace' };
  return { kind: "stamped", minter: asNamespace(minter) };
}
