import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  TabsProvider,
  useTabs,
  navigate,
  setSurfaceMode,
  getSurfaceMode,
  useSurfaceMode,
  exitToPreviousMode,
  type TabsApi,
  type NavigateOptions,
} from "./internal/use-tabs";
export { appLink, appLinkProps } from "./internal/app-link";
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
  registerPlacementCapabilities,
  peekDefaultPlacement,
  useDefaultPlacement,
  usePlacementCapabilities,
  placementIsNewTabFollows,
  placementHasAppThemeScope,
  placementOwnsChrome,
  type PlacementCapabilities,
} from "./internal/placement-registry";

export default {
  description:
    "Tab manager for the app switcher: the open-tab set, focus model, cross-app navigate(), the focused-placement module store, and the surface-written placement-capabilities registry.",
} satisfies PluginDefinition;
