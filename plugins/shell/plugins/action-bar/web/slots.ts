import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { Activity } from "@plugins/primitives/plugins/css/plugins/activity-ring/web";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { Audience } from "@plugins/audience/core";

/**
 * An action-bar contribution: its component, and who it is for — `audience:
 * "developer"` keeps it out of the bar (or the gear popover) until Developer
 * mode is on, the same vocabulary as `defineApp({ audience })`. Omitted = everyone.
 * The host gates it (`ForAudience`) and draws the developer mark on it; the
 * contribution never reads the audience nor draws the mark.
 */
export interface ActionBarContribution {
  component: ComponentType;
  audience?: Audience;
}

/**
 * The shared set of cross-app action buttons (Improve, Build, Screenshot, …),
 * plus the view options folded behind the bar's single gear button.
 *
 * Rendered by the global action bar (its docked tab-bar strip and its floating
 * overlay). Plugins contribute here instead of `Shell.Toolbar` so both mounts
 * stay in sync automatically.
 */
export const ActionBar = {
  // Size-owning: both surfaces (the docked tab-bar strip + the floating bar)
  // render this slot, so declaring `sm` here keeps every action button one
  // consistent height. `sm` is the DEFAULT: a host may pick another density for
  // the whole slot (`<ActionBar.Item.Render controlSize="md"/>` — the floating
  // capsule does). Contributions should omit `size` and inherit.
  Item: defineRenderSlot<ActionBarContribution>({
    controlSize: "sm",
  }),
  /**
   * How the app is shown rather than something to do in it — the surface mode,
   * browser fullscreen, layout editing. These are set once and left alone, so
   * they live in the bar's gear popover instead of each taking a toolbar button.
   *
   * The popover body is a `ControlPanel`, so each contribution renders ONE
   * control-panel row (`ControlPanel.Row` — a switch for an on/off option — or
   * `ControlPanel.Setting` for a value picked from a control).
   *
   * Most are developer tools (`audience: "developer"`): for a regular user the
   * popover holds only the Developer mode switch, which order config keeps first.
   */
  ViewOption: defineRenderSlot<ActionBarContribution>(),
  /**
   * Background work the COLLAPSED bar should show while every item is hidden:
   * each contribution's hook answers what its work is doing right now (`null`
   * when nothing). The bar merges them into the ring around its health dot —
   * any `running` spins it, else any `failed` breaks it — and appends the
   * labels to the dot's tooltip — only while collapsed: open, the row's own
   * items show the work, and the dot is plain health again. A plain `defineSlot`: the bar owns the merge,
   * so there is no order for a user to curate.
   *
   * ```ts
   * ActionBar.Activity({ id: "build", useActivity: useBuildActivity })
   * ```
   */
  Activity: defineSlot<{
    id: string;
    useActivity: Hook<() => Activity | null>;
  }>({ docLabel: (c) => c.id }),
  /**
   * Compact chips shown beside the COLLAPSED bar's health dot — something the
   * user should act on even while the bar is closed (Reload). A contribution
   * renders `null` when it has nothing to say. Unmounted while the bar is open:
   * the expanded row shows the full items, which carry the same action.
   * Like `Item`, `sm` is the default and the host may pass its own density.
   */
  Glance: defineRenderSlot<{ component: ComponentType }>({
    controlSize: "sm",
  }),
};
