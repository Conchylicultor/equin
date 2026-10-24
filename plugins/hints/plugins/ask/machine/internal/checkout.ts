import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";

// The main checkout's root, resolved once at boot (`onReadyBlocking`): a
// profile's `instructions` is synchronous, and every launch happens after the
// barrier, so the agent's CLAUDE.md can name the path without a git call per
// launch.
let checkoutRoot: string | null = null;

/** Resolve the checkout root (idempotent: a memoized `git rev-parse`). */
export async function resolveCheckoutRoot(): Promise<void> {
  checkoutRoot = await getMainRepoRoot();
}

/** The main checkout's root. Throws before {@link resolveCheckoutRoot} ran. */
export function checkoutRootPath(): string {
  if (checkoutRoot === null) {
    throw new Error(
      "[hints.ask] the checkout root is not resolved yet — a launch before the boot barrier?",
    );
  }
  return checkoutRoot;
}
