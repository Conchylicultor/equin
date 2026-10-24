import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  useRootThemeScope,
  useRootThemeScopeState,
} from "./internal/use-root-theme-scope";
export { useAppSettingsScope } from "./internal/use-app-settings-scope";

export default {
  description:
    "Theme-scope helpers: the single definition of the focused full-surface app's theme scope, which decides the :root token layer and the document's light/dark (useRootThemeScopeState keeps the not-registered-yet window apart), and useAppSettingsScope — the app:<id> config scope per-app theme settings (variants) are read in: the nearest app theme boundary's (a pane's home app), else the focused app's.",
} satisfies PluginDefinition;
