import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  activeRoutePrefix,
  peekAddressRoot,
  setActiveRoutePrefix,
  setAddressRoot,
  setRoutePrefixes,
  splitRoutePrefix,
  withActiveRoutePrefix,
  type SplitRoutePath,
} from "./internal/route-prefix";

export default {
  description:
    "Route prefixes: a leading address-bar segment owned by a surface mode rather than an app (the desktop's /desktop, written before the focused window's URL). The known prefixes every read strips (splitRoutePrefix, used by pane's currentRoutePath) and the active prefix the current mode writes (withActiveRoutePrefix, used by the shell history adapter and openInBrowserTab). Also the address root (setAddressRoot, from the composition's homeAtRoot): the base path of the app a released composition serves at / — put back by every read, dropped by every write (core: addressPathOf / routePathOf, the pure mapping every side shares). A leaf, so both the pane primitive and link-gesture read it.",
  contributions: [],
} satisfies PluginDefinition;
