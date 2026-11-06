import { defineRefReaction } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { followMain } from "./follow-main";

/**
 * Main moved: a declared service's dependency may now build to another
 * identity — so follow, whether or not main's build restarts the backend. A
 * push touching only a service's own sources (the menu-bar helper's `rust/`)
 * leaves the server code unchanged, and main's build then keeps its backend
 * (no restart, no boot, no `onReady`): that push never reached the tray.
 * Whether the dependency changed decides, inside `followMain` (an unchanged
 * identity is a no-op reconcile), not whether the backend restarted.
 *
 * In-process, main's backend only (a worktree's checkout is not what the
 * machine's services run). Main's boot is the fallback for an advance the
 * backend was down for. Not awaited, as at boot: a reconcile (an install into
 * the macOS app, a reload) must not hold the watcher's other reactions or its
 * durable emit; a rejection stays loud.
 */
export const followMainReaction = defineRefReaction({
  name: "login-services.follow-main",
  refName: "refs/heads/main",
  run: () => {
    if (isMain()) void followMain();
    return Promise.resolve();
  },
});
