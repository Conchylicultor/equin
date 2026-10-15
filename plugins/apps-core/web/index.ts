import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "./slots";

export {
  Apps,
  type AppEntry,
  type RailFramingContribution,
  type SurfaceContribution,
  type TabBarContribution,
  type OverlayContribution,
} from "./slots";
export {
  useActiveApp,
  usePathname,
  type ActiveApp,
} from "./internal/use-active-app";
export {
  matchAppForPath,
  resolveAppForPath,
  type ResolvedApp,
} from "./internal/resolve-app";
export { homeApp, useHomeApp, type HomeApp } from "./internal/home-app";
export { useCurrentAppId } from "./use-current-app-id";
export { setFocusedApp, useFocusedAppId } from "./internal/focused-app-store";
export type { Placement } from "../core";

export default {
  description:
    "App switcher rail. Wraps per-app shells; plugins contribute via Apps.App.",
  loadBearing: true,
  slots: Apps,
} satisfies PluginDefinition;
