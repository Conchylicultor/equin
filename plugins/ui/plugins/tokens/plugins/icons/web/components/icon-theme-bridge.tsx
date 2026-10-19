import { useMemo } from "react";
import { useScopeMembership } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Apps } from "@plugins/apps-core/web";
import { useRootThemeScope } from "@plugins/apps-core/plugins/theme-scope/web";
import {
  appThemeScope,
  fixedThemeScope,
  subThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  resolveFixedTheme,
  themeSelectionConfig,
  type FixedTheme,
  type SubTheme,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  ThemeEngine,
  useResolvedColorMode,
  useResolvedTheme,
} from "@plugins/ui/plugins/theme-engine/web";
import { usePublishIconStyle } from "@plugins/ui/plugins/icons/web";
import { iconsGroup, readIconTokens } from "../../core";

/**
 * Tells the icons primitive what every painted theme scope says about icons.
 *
 * It publishes one style per scope the theme engine paints, keyed by the same
 * scope token a `<Theme>` boundary names, mirroring how the CSS falls back:
 *
 * - the root (`:root`, no boundary): the focused full-surface app's theme, or
 *   the desktop's;
 * - each app with its OWN theme document (`app:<id>`) — an app without one
 *   draws with the root's style, as its region inherits `:root`;
 * - each fixed theme (`fixed:<id>`, the app chrome), resolved over the schema
 *   defaults alone;
 * - each sub-theme that names this group (`sub:<id>`), its values over the
 *   root's. (A sub-theme sits over whatever scope surrounds it; the one we have,
 *   the website's page, sits over the root.)
 *
 * A scope whose theme is still loading publishes nothing: its icons draw in
 * the global default style meanwhile, the same glyphs in the same box.
 */
export function IconThemeBridge() {
  const rootScope = useRootThemeScope();
  const apps = Apps.App.useContributions();
  const fixedThemes = ThemeEngine.FixedTheme.useContributions();
  const subThemes = ThemeEngine.SubTheme.useContributions();
  return (
    <>
      <SelectedScope themeScope={rootScope} publishAs={undefined} />
      {apps.map((app) => (
        <AppScope key={app.id} appId={app.id} />
      ))}
      {fixedThemes.map((fixed) => (
        <FixedScope key={fixed.id} fixed={fixed} />
      ))}
      {subThemes.map((sub) => (
        <SubScope key={sub.id} sub={sub} rootScope={rootScope} />
      ))}
    </>
  );
}

function AppScope({ appId }: { appId: string }) {
  const scope = appThemeScope(appId);
  const ownsTheme = useScopeMembership(themeSelectionConfig, scope);
  // While membership is unknown the scope publishes nothing, like a scope
  // whose theme is still loading. A failed read keeps its last-known answer.
  const owns = foldResource(ownsTheme, {
    loading: () => false,
    error: (_error, stale) => stale ?? false,
    ready: (member) => member,
  });
  if (!owns) return null;
  return <SelectedScope themeScope={scope} publishAs={scope} />;
}

/** The icon values of the theme `themeScope` selects, in the current color mode (null while pending). */
function useSelectedIconValues(
  themeScope: string | undefined,
): Record<string, string> | null {
  const resolved = useResolvedTheme(themeScope);
  const mode = useResolvedColorMode();
  if (resolved.pending) return null;
  return resolved.theme.groups[iconsGroup.id]![mode];
}

function SelectedScope({
  themeScope,
  publishAs,
}: {
  themeScope: string | undefined;
  publishAs: string | undefined;
}) {
  const values = useSelectedIconValues(themeScope);
  if (values === null) return null;
  return <Publish scope={publishAs} values={values} />;
}

function FixedScope({ fixed }: { fixed: FixedTheme }) {
  const groups = ThemeEngine.TokenGroup.useContributions();
  const values = useMemo(
    () =>
      resolveFixedTheme(
        fixed,
        groups.map((g) => g.descriptor),
      ).theme.groups[iconsGroup.id]![fixed.scheme],
    [fixed, groups],
  );
  return <Publish scope={fixedThemeScope(fixed)} values={values} />;
}

function SubScope({
  sub,
  rootScope,
}: {
  sub: SubTheme;
  rootScope: string | undefined;
}) {
  const fragment = sub.fragments.find((f) => f.groupId === iconsGroup.id);
  const mode = useResolvedColorMode();
  const root = useSelectedIconValues(rootScope);
  if (fragment === undefined || root === null) return null;
  const own = fragment[mode];
  const values: Record<string, string> = { ...root };
  for (const [token, value] of Object.entries(own)) {
    if (value !== undefined) values[token] = value;
  }
  return <Publish scope={subThemeScope(sub)} values={values} />;
}

function Publish({
  scope,
  values,
}: {
  scope: string | undefined;
  values: Readonly<Record<string, string | undefined>>;
}) {
  usePublishIconStyle(scope, readIconTokens(values));
  return null;
}
