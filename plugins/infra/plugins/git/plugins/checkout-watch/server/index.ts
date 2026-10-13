import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { acquireCheckoutWatch } from "./internal/checkout-watch";
export type {
  CheckoutChange,
  CheckoutRefs,
  CheckoutWatchRelease,
  CheckoutWatchRequest,
} from "./internal/checkout-watch";

export default {
  description:
    "The checkout watch hub: acquireCheckoutWatch(root, { refs, onChange }) hears every change that can move a git checkout's state — its working tree and its git dir (HEAD, index, and the refs the reader names beside its own branch; a linked worktree's git dir and the common refs live outside it) — each change tagged worktree or git, refcounted per checkout over the shared directory-watch hub, each reader's reaction coalesced (one running plus one pending).",
} satisfies ServerPluginDefinition;
