import type { ComponentType } from "react";
import {
  defineSlot,
  defineSlotFacade,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import {
  defineRenderSlot,
  type RenderSlot,
} from "@plugins/primitives/plugins/slot-render/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import type { AppEntry, AppEntrySpec, RailFramingProps } from "../core";

/** One framing host that wraps the rail + app content; see RailFramingProps. */
export interface RailFramingContribution {
  component: ComponentType<RailFramingProps>;
}

/**
 * The single surface body that renders every open tab at once under the ONE
 * surface {@link Placement} mode (docked / windows / solo). The mode is
 * per-surface, never per-tab, so the surface "looks like" tabs / desktop /
 * full-app as a single mutually-exclusive choice — two modes can never be
 * visible at once. The body reads the whole tab lifecycle + mode from
 * `useTabs()`, so the host forwards no props (the empty-object contract).
 */
export interface SurfaceContribution {
  component: ComponentType<Record<string, never>>;
}

/** One piece of floating chrome over the apps surface; see `Apps.Overlay`. */
export interface OverlayContribution {
  /** Unique among the overlays; keys the rendered list. */
  id: string;
  component: ComponentType<Record<string, never>>;
}

/** The top tab strip. A single-contribution slot (the `tab-bar` plugin); `apps`
 * renders nothing here when no contributor is present (chrome-less surface). */
export interface TabBarContribution {
  component: ComponentType<Record<string, never>>;
}

export type { AppLaunch, AppEntrySpec, AppEntry } from "../core";

const appSlot = defineRenderSlot<AppEntry>({
  docLabel: (p) => p.app.name,
});

/**
 * The `Apps.App` slot, with a call signature that accepts ONLY an
 * {@link AppEntrySpec} — writing `id`, `path`, `tooltip` or `icon` is a type
 * error, because there is nothing left to write them into.
 *
 * Declared explicitly rather than inferred from `Object.assign`: an intersection
 * of two call signatures reads as an overload set, which would let an author
 * reach the raw slot's `id`-taking signature again.
 */
export interface AppSlot {
  (entry: AppEntrySpec): Contribution;
  id: string;
  useContributions: RenderSlot<AppEntry>["useContributions"];
  useFacts: RenderSlot<AppEntry>["useFacts"];
  Render: RenderSlot<AppEntry>["Render"];
  /** Carried through so this hand-built callable is a COMPLETE slot handle: the
   * barrel declares `Apps` (this object) rather than the private `appSlot`, and
   * a declaration missing `meta` leaves the real slot undeclared. */
  meta: RenderSlot<AppEntry>["meta"];
}

/** The contribution restates nothing about the app, so the framework-required
 *  contribution id and the icon are derived from the `AppRef` here — the one
 *  place they can be, and therefore the one value each can ever have. */
const App: AppSlot = defineSlotFacade(
  (entry: AppEntrySpec) =>
    appSlot({
      ...entry,
      id: entry.app.id,
      icon: appIcon(entry.app.icon, { color: entry.app.iconColor }),
    }),
  appSlot,
) as unknown as AppSlot;

export const Apps = {
  App,
  /** The far-left app-rail framing (rail / hidden). The active variant owns the
   * outer wrapper and the `--app-rail-width` var (the rail's own width); the
   * rail sits as a flex sibling of the app body. */
  RailFraming: defineSlot<RailFramingContribution>({
    docLabel: () => "Rail framing",
  }),
  /** The surface body that lays out every open tab by its per-tab placement. A
   * single-contribution render slot (the `surface` plugin); `apps` falls back to
   * its built-in docked-only strip when no contributor is present. */
  Surface: defineSlot<SurfaceContribution>({
    docLabel: () => "Surface",
  }),
  /** The top tab strip. A single-contribution slot (the `tab-bar` plugin);
   * `apps` renders nothing here when no contributor is present (chrome-less
   * surface). Distinct from `TabBarActions` (the trailing action zone inside
   * the strip); this slot hosts the strip itself. */
  TabBar: defineSlot<TabBarContribution>({
    docLabel: () => "Tab bar",
  }),
  /** Trailing tab-bar action zone (next to `+`), where the `surface` plugin
   * drops its in-strip placement control. `apps` owns only the seam; the control
   * stays plugin-owned. */
  TabBarActions: defineRenderSlot<{ component: ComponentType }>({
    docLabel: () => "Tab bar actions",
  }),
  /** Chrome mounted once over the whole apps surface, INSIDE the tab state
   * (`TabsProvider`) — for floating chrome that switches apps or tabs, which
   * `Core.Root` (outside the tab state) cannot do. Each contribution positions
   * itself (fixed) and decides when it shows. */
  Overlay: defineSlot<OverlayContribution>({
    docLabel: () => "Overlay",
  }),
};
