import {
  defineRootSlot,
  defineSlot,
} from "@plugins/framework/plugins/web-sdk/core";
import type { IconFamily } from "../core";

/** One contributed icon family: a drawing a theme scope's `iconFamily` can pick. */
export interface IconFamilyContribution {
  family: IconFamily;
}

export const Icons = {
  // What `<Icon>` needs on the page and cannot import — the sprite sheet it
  // draws `<use href>` into, and the bridge that publishes each scope's icon
  // style. Both sit above this leaf (they read live state and the theme), so the
  // import would be a cycle; they contribute here as companions instead, and
  // ship wherever icons do.
  Root: defineRootSlot(),
  // The icon families beyond Material: Lucide (this plugin's own) and every
  // app-drawn family (`defineIconFamily`). The open set the `iconFamily` token
  // picks from; `IconFamilyHost` publishes it to `<Icon>`.
  Family: defineSlot<IconFamilyContribution>({
    docLabel: (p) => p.family.label,
  }),
};
