import { Pane as PaneSlots } from "./slots";
import { paneHeaderContributions } from "./header-slot";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

// A pane's identity travels WITH the pane: `Pane.define({ route: defineRoute({…}) })`
// is one call from one barrel. `defineRoute` itself is runtime-agnostic and lives in
// `core/` (a server plugin builds the same link from it), but a `web/` file that
// declares a pane has no other reason to reach the core barrel — so re-exporting the
// factory here removes the second import from every pane file. This is a re-export of
// the plugin's OWN core, not a proxy for another plugin's symbol.
// `pane/no-core-define-route-in-web` keeps this the single spelling inside `web/`.
export { defineRoute } from "../core";

export {
  Pane,
  type,
  usePaneMatch,
  useCurrentPane,
  PaneMatchContext,
  PaneInstanceContext,
  PaneBasePathContext,
  setBasePath,
  peekBasePath,
  stripBasePath,
  currentRoutePath,
  useRoute,
  useRouteState,
  usePaneTitle,
  useIndexMatch,
  usePathname,
  useSyncPaneRegistry,
  paneOwnerFor,
  parseUrl,
  peekRoute,
  reorderRoute,
  restoreRoute,
  clearRoute,
  openPane,
  useOpenPane,
  createPaneStore,
  setLiveStore,
  PaneStoreContext,
  usePaneStore,
  PaneSurfaceProvider,
  PaneSurfaceAppContext,
  useSurfaceAppId,
  PaneLoadScopeContext,
} from "./pane";
export type {
  PaneObject,
  PromoteAction,
  PaneRouteEntry,
  PaneMatch,
  MatchEntry,
  PaneChromeConfig,
  PaneTitleSpec,
  PaneTitleHook,
  PaneToggleOpts,
  TypeMarker,
  PaneInternal,
  PaneOptions,
  Hint,
  AnyPane,
  PaneSlot,
  ParsedRoute,
  RouteState,
  PaneOpenMode,
  OpenPaneFn,
  ResolveHook,
  PaneStore,
  PaneHeaderItem,
} from "./pane";
export { resolveFrom, resolveRow, rowOrStale } from "./resolve";
export type { ResolveResult } from "./resolve";
export { setHistoryAdapter } from "./history-sink";
export {
  appNavSink,
  AppNavBoundary,
  useAppNavBoundary,
  type AppNavigator,
} from "./app-nav-sink";
export type {
  HistoryAdapter,
  LocationChange,
  PaneHistoryState,
  SerializedSlot,
} from "./history-sink";
export { PaneChrome } from "./components/pane-chrome";
export { PaneHeaderCell } from "./components/pane-header-item";
export type {
  PaneHeaderAction,
  PaneHeaderComponent,
} from "./components/pane-header-item";
export {
  definePaneHeaderSlot,
  type PaneHeaderSlot,
  type PaneHeaderSlotOptions,
} from "./header-slot";
export { PaneScroll, type PaneScrollProps } from "./components/pane-scroll";
export { PaneIconAction } from "./components/pane-icon-action";
export { PaneBox, paneThemeScope } from "./components/pane-box";
export { useRenderSync } from "./use-render-sync";
export { PaneLayoutContext } from "./maximize-context";
export { SurfaceChromeContext } from "./surface-chrome-context";
export { useReservesFloatingBar } from "./reserves-floating-bar";
export type { SurfaceChrome } from "./surface-chrome-context";

export default {
  description: "Unified pane primitive: Pane.define and chrome components.",
  loadBearing: true,
  // The `title` item of every pane header — see `header-slot.ts` for why this is
  // a live array rewritten by each declaration pass rather than a literal.
  contributions: paneHeaderContributions,
  slots: PaneSlots,
} satisfies PluginDefinition;
