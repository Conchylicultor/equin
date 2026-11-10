import { useMemo } from "react";
import { useScopeMembership } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Apps } from "@plugins/apps-core/web";
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
  type TokenGroupFragment,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  ThemeEngine,
  useResolvedColorMode,
  useResolvedTheme,
} from "@plugins/ui/plugins/theme-engine/web";
import {
  usePublishIconStyle,
  usePublishIconStyleLayer,
} from "@plugins/ui/plugins/icons/web";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { iconsGroup, readIconTokenLayer, readIconTokens } from "../../core";

/**
 * Tells the icons primitive what every painted theme scope says about icons.
 *
 * It publishes one style per scope the theme engine paints, keyed by the same
 * scope token a `<Theme>` boundary names, mirroring how the CSS falls back:
 *
 * - the root (`:root`, no boundary): the desktop's theme — `:root` never
 *   follows the focused app (theme-engine's ThemeInjector);
 * - each app with its OWN theme document (`app:<id>`) — an app without one
 *   draws with the root's style, as its region inherits `:root`;
 * - each fixed theme (`fixed:<id>`, the app chrome), resolved over the schema
 *   defaults alone;
 * - each sub-theme that names this group (`sub:<id>`), as a LAYER of only the
 *   tokens it names: the icons primitive wears it over the style of whatever
 *   scope encloses the region, exactly as the CSS block sits over the
 *   surrounding theme.
 *
 * A scope whose theme is still loading publishes nothing: its icons draw in
 * the global default style meanwhile, the same glyphs in the same box.
 */
export function IconThemeBridge() {
  // A root host of every scope (`scope: "each"`). Inside a `<PluginScope>` it
  // publishes the SCOPE's styles (the icons primitive keys them by the plugin
  // scope), as the theme painters paint its blocks: the root is the scope's
  // base theme, and every app publishes — one without its own document
  // resolves to the base, as its CSS block does.
  const inScope = usePluginScopeId() !== null;
  const apps = Apps.App.useContributions();
  const fixedThemes = ThemeEngine.FixedTheme.useContributions();
  const subThemes = ThemeEngine.SubTheme.useContributions();
  return (
    <>
      <SelectedScope themeScope={undefined} publishAs={undefined} />
      {apps.map((app) => (
        <AppScope key={app.id} appId={app.id} always={inScope} />
      ))}
      {fixedThemes.map((fixed) => (
        <FixedScope key={fixed.id} fixed={fixed} />
      ))}
      {subThemes.map((sub) => (
        <SubScope key={sub.id} sub={sub} />
      ))}
    </>
  );
}

function AppScope({ appId, always }: { appId: string; always: boolean }) {
  const scope = appThemeScope(appId);
  const ownsTheme = useScopeMembership(themeSelectionConfig, scope);
  // While membership is unknown the scope publishes nothing, like a scope
  // whose theme is still loading. A failed read keeps its last-known answer.
  const owns = foldResource(ownsTheme, {
    loading: () => false,
    error: (_error, stale) => stale ?? false,
    ready: (member) => member,
  });
  if (!owns && !always) return null;
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

function SubScope({ sub }: { sub: SubTheme }) {
  const fragment = sub.fragments.find((f) => f.groupId === iconsGroup.id);
  if (fragment === undefined) return null;
  return <SubLayer sub={sub} fragment={fragment} />;
}

function SubLayer({
  sub,
  fragment,
}: {
  sub: SubTheme;
  fragment: TokenGroupFragment;
}) {
  const mode = useResolvedColorMode();
  const layer = readIconTokenLayer(fragment[mode]);
  usePublishIconStyleLayer(subThemeScope(sub), layer);
  return null;
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
