import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { AppShell } from "@plugins/primitives/plugins/app-shell/web";
import { AppBrand } from "./components/app-brand";
import { FloatingAppLauncher } from "./components/floating-app-launcher";
import { installedAppPresentation } from "./internal/installed-app";

export { appRow, appRowOverrides, type AppRow } from "./internal/installed-app";

export default {
  description:
    "The app brand every app shell draws (AppShell.Brand): the launcher — the current app's own mark — click for the composition's home app (the app gallery on main), hover or ArrowDown for a grid of every other installed app (switching exactly as the rail does) — plus, as the sidebar header, the current app's name linking to its own home. In solo (fullscreen) mode, a surface that draws no brand gets the launcher floating at the top-left, revealed as the pointer nears the corner.",
  contributions: [
    AppShell.Brand({ component: AppBrand }),
    Apps.Overlay({ id: "floating-launcher", component: FloatingAppLauncher }),
    installedAppPresentation,
  ],
} satisfies PluginDefinition;
