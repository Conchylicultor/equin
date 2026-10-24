import { useMemo } from "react";
import { Apps } from "@plugins/apps-core/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { useScopeIconStyles } from "@plugins/ui/plugins/icons/web";
import type { AppFamily } from "./model";

/**
 * Every installed app and the icon family its theme scope draws in — the style
 * the icons token bridge publishes for `app:<id>` (an app without a theme of
 * its own draws with the root's), so the same answer an `<Icon>` in that app
 * gets. No app is named: they are the `Apps.App` contributions.
 */
export function useAppFamilies(): readonly AppFamily[] {
  const apps = Apps.App.useContributions();
  const styles = useScopeIconStyles(apps.map((a) => appThemeScope(a.id)));
  return useMemo(
    () =>
      apps.map((a, i) => ({
        appId: a.id,
        appName: a.app.name,
        family: styles[i]!.family,
      })),
    [apps, styles],
  );
}
