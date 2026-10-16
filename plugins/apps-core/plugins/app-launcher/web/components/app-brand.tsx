import { useActiveApp } from "@plugins/apps-core/web";
import { useNavigate } from "@plugins/apps-core/plugins/tabs/web";
import { usePaneStore } from "@plugins/primitives/plugins/pane/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import type { AppShellBrandForm } from "@plugins/primitives/plugins/app-shell/web";
import { AppLauncher } from "./app-launcher";

/**
 * The `AppShell.Brand` contribution. `icon` is the launcher alone (the leading
 * edge of a sidebar-less app's top chrome); `header` heads the sidebar with the
 * launcher plus the current app's name (its `brandName` when it draws its own),
 * which links to that app's own home — its base path — rather than to the
 * gallery the launcher leads to. Both go through the surface's own pane store
 * and `useNavigate`, so inside an in-process app embed they stay in the embed.
 */
export function AppBrand({ form }: { form: AppShellBrandForm }) {
  const active = useActiveApp();
  const store = usePaneStore();
  const go = useNavigate();
  if (form === "icon" || !active) return <AppLauncher form={form} />;
  const home = active.app.basePath;
  return (
    <Line className="gap-sidebar-brand">
      <AppLauncher form={form} />
      <Button
        variant="ghost"
        {...linkProps({
          open: () => {
            // Already on the app's home: nothing to navigate to.
            if (store.routeUrl(store.getRoute()) === home) return;
            go(home);
          },
          href: () => home,
        })}
        // The name is the row's one flexible cell (it takes the slack and
        // truncates; the launcher stays rigid), its text at the leading edge
        // of that cell, padded by the theme's sidebar-metrics brand tokens.
        // eslint-disable-next-line layout/no-adhoc-layout -- justify-start re-anchors Button's own centred content to the leading edge of the fill cell
        className={cn(fillClasses("x"), "justify-start px-sidebar-brand-name")}
      >
        {active.brandName ? (
          <active.brandName />
        ) : (
          // The label rung, bold and tight, in the sidebar's emphasised text:
          // a brand in the sidebar chrome, not a heading of the page.
          <Text
            variant="label"
            className="font-bold tracking-tight text-sidebar-accent-foreground"
          >
            {active.app.name}
          </Text>
        )}
      </Button>
    </Line>
  );
}
