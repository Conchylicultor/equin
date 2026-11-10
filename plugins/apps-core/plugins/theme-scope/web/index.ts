import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useRootThemeScopeState } from "./internal/use-root-theme-scope";
export type { RootThemeScopeState } from "./internal/use-root-theme-scope";
export { useAppSettingsScope } from "./internal/use-app-settings-scope";

export default {
  description:
    "Theme-scope helpers: the single definition of the focused full-surface app's theme scope, which decides the document's light/dark and canvas (never the :root tokens, always the desktop's) (useRootThemeScopeState: a state that keeps the not-registered-yet window apart from 'no app owns the surface'), and useAppSettingsScope — the app:<id> config scope per-app theme settings (variants) are read in: the nearest app theme boundary's (a pane's home app), else the focused app's.",
} satisfies PluginDefinition;
