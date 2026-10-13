import noDetachedWatchReaction from "./no-detached-watch-reaction";
import noDirectParcelWatcher from "./no-direct-parcel-watcher";
import noRawFsWatch from "./no-raw-fs-watch";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "watcher-safety",
  rules: {
    "no-direct-parcel-watcher": noDirectParcelWatcher,
    // Sibling concern: every other way to watch files (node:fs watch APIs,
    // chokidar). `defineFileWatcher` / `watchForCommand` are the one way.
    "no-raw-fs-watch": noRawFsWatch,
    // A watch callback returns its async work, so the watch coalesces it.
    "no-detached-watch-reaction": noDetachedWatchReaction,
  },
} satisfies LintContribution;
