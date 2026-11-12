import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  TabsProvider,
  useTabs,
  useClaimTabTitle,
  navigate,
  setSurfaceMode,
  getSurfaceMode,
  useSurfaceMode,
  exitToPreviousMode,
  peekSurfaceEmpty,
  type TabsApi,
  type NavigateOptions,
  type EmbeddedTabSet,
  type EmbeddedAt,
} from "./internal/use-tabs";
export { appLink, appLinkProps } from "./internal/app-link";
export { useFocusedTabTitle } from "./internal/focused-tab-title-store";
export {
  useAppLink,
  useAppLinkProps,
  useNavigate,
} from "./internal/use-navigate";
export { useActivateApp } from "./internal/use-activate-app";
export {
  appPathFor,
  appContributionFor,
  type Tab,
} from "./internal/tabs-store";
export { loadScopePrefixFor } from "./internal/load-scope";
export { useSurfaceFocused } from "./internal/use-surface-focused";
export {
  claimTabSet,
  peekFocusedTabSet,
  peekTabSets,
  type OpenTab,
  useFocusedTabSet,
  type TabSetHandle,
} from "./internal/tab-sets";
export {
  usePlacementRegistry,
  peekDefaultPlacement,
  useDefaultPlacement,
  usePlacementCapabilities,
  placementIsNewTabFollows,
  placementHasAppThemeScope,
  placementOwnsChrome,
  type PlacementCapabilities,
  type PlacementRegistry,
} from "./internal/placement-registry";

export default {
  description:
    "Tab manager for the app switcher: the open-tab set, focus model, cross-app navigate(), the focused-placement module store, the focused tab's title as a module signal (useFocusedTabTitle, readable outside TabsProvider), and the surface-written placement-capabilities registry — one per tab set: the page's own, or an embedded one (TabsProvider embedded={{ at, onLeave, onLocationChange?, browserTabUrl? }}, an AppEmbed's: seeded, never live, persisting nothing, publishing no page-global signal, behind its own navigation boundary), found from outside React by peekFocusedTabSet().",
} satisfies PluginDefinition;
