import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hint } from "@plugins/hints/core";

export const AppLauncherSlots = {
  /**
   * The tip the launcher carries after the surface LEFT mode `mode` for
   * another — how to go back (the desktop's "Go back to the desktop", after a
   * window went full screen: the launcher's grid lists the desktop). Asked
   * instead of "Switch apps"; its `anchor` must be `appLauncherAnchor`, and it
   * should `supersedes: [appLauncherHint]` so "Switch apps" never follows it.
   * Declare the hint itself with `Hints.Hint` too (the catalog).
   */
  ReturnTip: defineSlot<{ mode: string; hint: Hint }>({
    docLabel: (p) => `${p.mode} → ${p.hint.id}`,
  }),
};
