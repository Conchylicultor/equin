import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { gitCheckoutServed } from "./internal/checkout";
import { gitIgnoredServed, gitStatusServed } from "./internal/live";

export default {
  description:
    "Git awareness for the file explorer, desktop half (both reads needsMachine — a host without the computer has no checkout): which checkout holds a folder (the file-explorer.git-checkout snapshot value, git rev-parse) and the checkout's status as the file-explorer.git-status live value — each path's status vs HEAD and vs the main merge-base, untracked folders collapsed, never an --ignored walk of the tree — memoized behind a content signature and pushed from the shared checkout watch (infra/git/checkout-watch: working tree + git dir) while subscribed; and what git ignores in one listed folder as the file-explorer.git-ignored live value (its entries through one git check-ignore), pushed from a watch of the folder's entries and the checkout's ignore rules.",
  contributions: [
    ...gitStatusServed.declare,
    ...gitIgnoredServed.declare,
    ...gitCheckoutServed.declare,
  ],
} satisfies MachinePluginDefinition;
