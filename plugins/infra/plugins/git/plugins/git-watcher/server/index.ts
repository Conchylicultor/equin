import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { refAdvanced } from "./internal/tables-ref-advanced";
import { refHeadServed } from "./internal/ref-head-resource";
import { gitTagsServed } from "./internal/tags-resource";
import {
  gitRefsWatcher,
  startGitWatcher,
  stopGitWatcher,
} from "./internal/watcher";

export { refHeadServed } from "./internal/ref-head-resource";
export { gitTagsServed } from "./internal/tags-resource";
export {
  refAdvanced,
  _refAdvancedTriggers,
} from "./internal/tables-ref-advanced";
export { lastKnownMainSha } from "./internal/watcher";
export { defineRefReaction } from "./internal/reactions";
export type { RefReactionSpec } from "./internal/reactions";
export type { RefAdvancedPayload } from "../shared/types";

export default {
  description:
    "Watches local git refs (refs/heads/main plus the current worktree's own branch) via @parcel/watcher, and the repo's tags (a depth-1 watch of refs/tags plus packed-refs), notifying the git-watcher.tags live value when one is created, moved or deleted. On every ref advance it notifies the git-watcher.refHead live value, runs the registered in-process ref reactions (every backend, nothing queued in between), and emits the durable git.refAdvanced trigger event (main only).",
  loadBearing: true,
  contributions: [...refHeadServed.declare, ...gitTagsServed.declare],
  register: [refAdvanced, gitRefsWatcher],
  onReady: async () => {
    await startGitWatcher();
  },
  onShutdown: async () => {
    await stopGitWatcher();
  },
} satisfies ServerPluginDefinition;
