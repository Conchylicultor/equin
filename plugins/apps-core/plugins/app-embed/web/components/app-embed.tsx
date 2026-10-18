import { useCallback, useId, useState, type ReactNode } from "react";
import {
  appThemeScope,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  AppNavBoundary,
  createPaneStore,
  stripBasePath,
  type AppNavigator,
} from "@plugins/primitives/plugins/pane/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { Apps } from "@plugins/apps-core/web";
import { appPathFor } from "@plugins/apps-core/plugins/tabs/web";
import { SurfaceCore } from "@plugins/apps-core/plugins/tab-surface/web";

/** An app-rooted URL the embed was asked to open but does not hold (another app). */
export type AppEmbedLeave = (url: string) => void;

/** The default `onLeave`: say so, and stay. */
const refuseLeave: AppEmbedLeave = () => {
  showToast({
    title: "Opens outside this embed",
    description: "This app is embedded here; other apps are not part of it.",
  });
};

/**
 * One app surface rendered in-process — the same `SurfaceCore` a tab mounts,
 * inside its own box — with its own pane store, theme scope and navigation
 * boundary. It knows nothing about where its data comes from: around a
 * `<DemoScope>` it renders a demo, around nothing the real instance.
 *
 * - **Its own route.** A non-live pane store (never reads or writes the page
 *   URL or history), seeded with `route` (app-relative, `/c/<id>`). A row
 *   click, a pane open and Expand move this store only.
 * - **Its own theme scope.** `app:<id>`, as a tab's, with `transform-gpu` so
 *   the app shell's `position: fixed` sidebar resolves against the embed, not
 *   the viewport.
 * - **Its own navigation boundary.** Every cross-app hop read through the
 *   boundary (`usePromote`, `useNavigate`, `useAppLinkProps`,
 *   `useActivateApp`) comes here: a URL under the app's own base path moves
 *   the embed's route; anything else is `onLeave(url)` — by default a toast,
 *   and the embed stays. It never drives the host's tabs.
 *
 * Not a tab: no title reporter, no `mod+z` bindings. Size it with `className`
 * (it fills its box).
 */
export function AppEmbed({
  app,
  route,
  onLeave = refuseLeave,
  className,
}: {
  app: string;
  route: string;
  onLeave?: AppEmbedLeave;
  className?: string;
}): ReactNode {
  const apps = Apps.App.useContributions();
  const basePath = appPathFor(app, apps);
  const [store] = useState(() => {
    const s = createPaneStore({ live: false });
    s.setBasePath(basePath);
    s.seedPending(appRelative(route));
    return s;
  });
  const surfaceId = `embed:${useId()}`;
  const navigator = useCallback<AppNavigator>(
    (url) => {
      const path = new URL(url, "http://embed.invalid").pathname;
      const inApp = stripBasePath(path, basePath);
      if (inApp !== path || basePath === "/") {
        store.navigatePending(appRelative(inApp));
        return;
      }
      onLeave(url);
    },
    [store, basePath, onLeave],
  );
  return (
    <Theme
      name={appThemeScope(app)}
      surface="canvas"
      // `floating-bar-boundary`: the embed is a box on its host's page, not
      // the viewport's top-right corner — its headers must not reserve or
      // anchor the global floating action bar.
      // eslint-disable-next-line layout/no-adhoc-layout -- the embed's own box: `relative isolate` contains its overlays and stacking, `transform-gpu` makes it the containing block for the app shell's fixed sidebar
      className={cn(
        "floating-bar-boundary relative isolate size-full transform-gpu overflow-hidden",
        className,
      )}
    >
      <PluginErrorBoundary label={`App embed: ${app}`}>
        <AppNavBoundary navigator={navigator}>
          <SurfaceCore appId={app} store={store} surfaceId={surfaceId} />
        </AppNavBoundary>
      </PluginErrorBoundary>
    </Theme>
  );
}

/** `/c/x`, `c/x` → `c/x`: the raw app-relative path a pending route holds. */
function appRelative(path: string): string {
  return path.replace(/^\/+/, "");
}
