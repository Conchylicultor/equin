import { defineRootSlot } from "@plugins/framework/plugins/web-sdk/core";

export const Icons = {
  // What `<Icon>` needs on the page and cannot import — the sprite sheet it
  // draws `<use href>` into, and the bridge that publishes each scope's icon
  // style. Both sit above this leaf (they read live state and the theme), so the
  // import would be a cycle; they contribute here as companions instead, and
  // ship wherever icons do.
  Root: defineRootSlot(),
};
