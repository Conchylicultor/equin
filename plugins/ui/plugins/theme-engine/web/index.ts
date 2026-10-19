import {
  type PluginDefinition,
  Core,
} from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { themeSelectionConfig } from "../core";
import {
  ThemeInjector,
  AppScopeThemes,
  SubThemeStyles,
  FixedThemeStyles,
} from "./components/theme-injector";
import { ThemeSelectionsCollector } from "./theme-selections";
import { ThemeEngine } from "./slots";
import { defaultTheme } from "./default-theme";
import { useThemeOptions } from "./internal/theme-options";

export { ThemeEngine, useThemes } from "./slots";
export type {
  VariantGroupContribution,
  TokenGroupContribution,
  ThemeSourceContribution,
  ThemeSourceEntry,
  ThemeSourceFailure,
  ThemesState,
} from "./slots";
export { useResolvedTheme } from "./use-resolved-theme";
export type { ResolvedThemeState } from "./use-resolved-theme";
export { useThemeSelections, whenNoScopeSelects } from "./theme-selections";
export type { ThemeSelection, ThemeSelectionsState } from "./theme-selections";
export { themeResolutionReportSink } from "./internal/resolution-report-sink";
export type { ThemeResolutionFault } from "./internal/resolution-report-sink";
export { ThemeScope } from "./components/theme-scope";
export {
  ThemeScopeProvider,
  useThemeScopeId,
} from "./components/theme-scope-context";
export { ScopedAppTheme } from "./components/theme-injector";
export {
  useColorMode,
  useResolvedColorMode,
  useSetColorMode,
} from "./use-color-mode";
export type { ColorMode, ConfiguredColorMode } from "./use-color-mode";

export default {
  description:
    "Paints each scope's selected theme: the token-group, theme and theme-source slots, the theme selection config, and the injector that resolves one theme per scope into CSS variables.",
  contributions: [
    Core.Root({ component: ThemeInjector }),
    Core.Root({ component: AppScopeThemes }),
    Core.Root({ component: SubThemeStyles }),
    Core.Root({ component: FixedThemeStyles }),
    Core.Root({ component: ThemeSelectionsCollector }),
    ConfigV2.WebRegister({ descriptor: themeSelectionConfig }),
    DynamicEnum.Options({
      field: themeSelectionConfig.fields.theme,
      useOptions: useThemeOptions,
    }),
    ThemeEngine.Theme(defaultTheme),
  ],
  slots: ThemeEngine,
} satisfies PluginDefinition;
