import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { fileExplorerGitCheckout } from "../shared/resources";
import { handleGitCheckout } from "./internal/checkout";
import { gitStatusServed } from "./internal/live";

export default {
  description:
    "Git awareness for the file explorer, server half: which checkout holds a folder (GET /api/file-explorer/git/checkout, git rev-parse) and the checkout's status as the file-explorer.git-status live value — each path's status vs HEAD and vs the main merge-base, untracked and ignored folders collapsed — memoized behind a content signature and pushed from the shared checkout watch (infra/git/checkout-watch: working tree + git dir) while subscribed.",
  httpRoutes: {
    [fileExplorerGitCheckout.route]: handleGitCheckout,
  },
  contributions: [...gitStatusServed.declare],
} satisfies ServerPluginDefinition;
