import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { Fields } from "@plugins/fields/web";
import { AppShell } from "@plugins/primitives/plugins/app-shell/web";
import { Hints } from "@plugins/hints/web";
import { appIconIdentity, appLauncherHint } from "../core";
import { AppBrand } from "./components/app-brand";
import { FloatingAppLauncher } from "./components/floating-app-launcher";
import { installedAppPresentation } from "./internal/installed-app";
import { AppLauncherSlots } from "./slots";
import { PhoneActions } from "@plugins/apps-core/plugins/phone-actions/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { AppsSheet } from "./components/apps-sheet";

export { AppLauncherSlots } from "./slots";

export {
  AppIconCell,
  appRow,
  appRowOverrides,
  type AppRow,
} from "./internal/installed-app";

export default {
  description:
    "The app brand every app shell draws (AppShell.Brand): the launcher — the current app's own mark — click for the composition's home app (the app gallery on main), hover or ArrowDown for a grid of every other installed app (switching exactly as the rail does) — plus, as the sidebar header, the current app's name linking to its own home. Where no app switcher frames the surface — solo (fullscreen), or an AppEmbed, which draws no rail or tab bar — a surface that draws no brand gets the launcher floating at the top-left of its box, revealed as the pointer nears that corner. On a phone neither the top-left launcher nor the floating one is drawn: the phone action button's Apps sheet (PhoneActions.Action 'apps') is the app grid there.",
  slots: AppLauncherSlots,
  contributions: [
    AppShell.Brand({ component: AppBrand }),
    Apps.Overlay({ id: "floating-launcher", component: FloatingAppLauncher }),
    PhoneActions.Action({
      id: "apps",
      label: "Apps",
      icon: symbol("apps"),
      component: AppsSheet,
    }),
    installedAppPresentation,
    Fields.Identity({ identity: appIconIdentity }),
    Hints.Hint({ hint: appLauncherHint }),
  ],
} satisfies PluginDefinition;
