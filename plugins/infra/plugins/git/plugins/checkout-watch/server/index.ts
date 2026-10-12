import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { acquireCheckoutWatch } from "./internal/checkout-watch";
export type {
  CheckoutChange,
  CheckoutWatchRelease,
} from "./internal/checkout-watch";

export default {
  description:
    "The checkout watch hub: acquireCheckoutWatch(root, onChange) hears every change that can move a git checkout's state — its working tree and its git dir (HEAD, index, refs; a linked worktree's git dir and the common refs, which live outside it) — each change tagged worktree or git, refcounted per checkout over the shared directory-watch hub.",
} satisfies ServerPluginDefinition;
