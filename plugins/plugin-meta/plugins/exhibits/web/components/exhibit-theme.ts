import type { Exhibit } from "@plugins/plugin-meta/plugins/exhibits/core";
import { Apps } from "@plugins/apps-core/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

/** The `;theme` value naming the app chrome's fixed theme (rail, tab bar, action bar). */
const CHROME_THEME = "chrome";

export interface ThemeOption {
  /** The `;theme` route value. */
  value: string;
  label: string;
  /** The `data-theme-scope` token the frames wear. */
  scope: string;
}

/** The `;theme` value an exhibit opens in: where it lives, else this pane's own app. */
export function defaultThemeOf(exhibit: Exhibit): string {
  const { home } = exhibit;
  if (home === undefined) return debugApp.id;
  return home === "chrome" ? CHROME_THEME : home.id;
}

/**
 * Every theme an exhibit can be viewed in: each installed app's and the app
 * chrome's. The exhibit's default comes first, labelled with why it is the
 * default — its home, or Debug (this pane's own app) for an exhibit that lives
 * in no one app.
 */
export function useThemeOptions(exhibit: Exhibit): readonly ThemeOption[] {
  const apps = Apps.App.useContributions();
  const fallback = defaultThemeOf(exhibit);
  const all: ThemeOption[] = [
    ...apps.map((a) => ({
      value: a.app.id,
      label: a.app.name,
      scope: appThemeScope(a.app.id),
    })),
    { value: CHROME_THEME, label: "App chrome", scope: chromeThemeScope },
  ];
  const note = exhibit.home === undefined ? "this pane's app" : "its home";
  const first = all.find((o) => o.value === fallback);
  return first === undefined
    ? all
    : [
        { ...first, label: `${first.label} (${note})` },
        ...all.filter((o) => o !== first),
      ];
}
