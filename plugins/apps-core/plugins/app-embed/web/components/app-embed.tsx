import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  AppNavBoundary,
  createPaneStore,
  type AppNavigator,
  type PaneStore,
} from "@plugins/primitives/plugins/pane/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  Apps,
  resolveAppForPath,
  type ActiveApp,
} from "@plugins/apps-core/web";
import { appPathFor } from "@plugins/apps-core/plugins/tabs/web";
import { SurfaceCore } from "@plugins/apps-core/plugins/tab-surface/web";

/** An app-rooted URL the embed was asked to open but cannot hold (no tab app in scope owns it). */
export type AppEmbedLeave = (url: string) => void;

/** The default `onLeave`: say so, and stay. */
const refuseLeave: AppEmbedLeave = () => {
  showToast({
    title: "Opens outside this embed",
    description:
      "This app is embedded here; that destination is not part of it.",
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
 * - **Its own theme scope.** `app:<id>` of the app it shows, as a tab's, with
 *   `transform-gpu` so the app shell's `position: fixed` sidebar resolves
 *   against the embed, not the viewport.
 * - **Its own navigation boundary.** Every cross-app hop read through the
 *   boundary (`usePromote`, `useBack`, `useOpenPane`, `useNavigate`,
 *   `useAppLink(Props)`, `useActivateApp`) comes here, and the URL is resolved
 *   against the tab apps in scope (`resolveAppForPath` over `Apps.App` — inside
 *   a `<PluginScope>`, the composition's): a URL of the app on screen moves the
 *   embed's route; one of another tab app in scope swaps the embed to that app
 *   (a fresh non-live store at its base path, as an in-tab app swap does — the
 *   previous app is not kept alive); anything else (an app out of scope, a
 *   surface-mode app, no app at all) is `onLeave(url)` — by default a toast,
 *   and the embed stays. It never drives the host's tabs.
 *
 * Not a tab: no title reporter, no `mod+z` bindings. Size it with `className`
 * (it fills its box). `app` / `route` seed the first session only.
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
  const [session, setSession] = useState<EmbedSession>(() => ({
    appId: app,
    store: sessionStore(app, apps, route),
    seq: 0,
  }));
  // The session a navigation acts on is the one current WHEN it runs, never
  // the one its caller rendered under: a navigator held across an await (an
  // import, then "open in Sonata") must not reuse a `seq` the current session
  // already keys, nor move a store that is no longer mounted.
  const current = useRef(session);
  const surfaceId = `embed:${useId()}`;
  const navigator = useCallback<AppNavigator>(
    (url) => {
      const path = new URL(url, "http://embed.invalid").pathname;
      // Tab apps only: a surface-mode app owns no URL, so it resolves to
      // nothing and leaves, as does an app outside the scope.
      const resolved = resolveAppForPath(path, apps);
      if (resolved === undefined) {
        onLeave(url);
        return;
      }
      const now = current.current;
      if (resolved.app.id === now.appId) {
        now.store.navigatePending(appRelative(resolved.routePath));
        return;
      }
      const next: EmbedSession = {
        appId: resolved.app.id,
        store: sessionStore(resolved.app.id, apps, resolved.routePath),
        seq: now.seq + 1,
      };
      current.current = next;
      setSession(next);
    },
    [apps, onLeave],
  );
  return (
    <Theme
      name={appThemeScope(session.appId)}
      surface="canvas"
      // Which app the embed shows, for a reader outside it (an e2e script).
      data-app-embed={session.appId}
      // `floating-bar-boundary`: the embed is a box on its host's page, not
      // the viewport's top-right corner — its headers must not reserve or
      // anchor the global floating action bar.
      // eslint-disable-next-line layout/no-adhoc-layout -- the embed's own box: `relative isolate` contains its overlays and stacking, `transform-gpu` makes it the containing block for the app shell's fixed sidebar
      className={cn(
        "floating-bar-boundary relative isolate size-full transform-gpu overflow-hidden",
        className,
      )}
    >
      <PluginErrorBoundary label={`App embed: ${session.appId}`}>
        <AppNavBoundary navigator={navigator}>
          {/* Keyed by session: another app is a fresh surface, never the
              previous app's providers re-pointed. */}
          <SurfaceCore
            key={session.seq}
            appId={session.appId}
            store={session.store}
            surfaceId={surfaceId}
          />
        </AppNavBoundary>
      </PluginErrorBoundary>
    </Theme>
  );
}

/** The app the embed shows and its route; `seq` keys the surface per session. */
interface EmbedSession {
  appId: string;
  store: PaneStore;
  seq: number;
}

/**
 * A session's store: non-live (never the page URL), at the app's base path,
 * holding `route` pending — the recipe a background tab's store is built with.
 * The app's bare root seeds nothing: a resolved-empty route is its index.
 */
function sessionStore(
  appId: string,
  apps: readonly ActiveApp[],
  route: string,
): PaneStore {
  const store = createPaneStore({ live: false });
  store.setBasePath(appPathFor(appId, apps));
  const rawPath = appRelative(route);
  if (rawPath !== "") store.seedPending(rawPath);
  return store;
}

/** `/c/x`, `c/x` → `c/x`: the raw app-relative path a pending route holds. */
function appRelative(path: string): string {
  return path.replace(/^\/+/, "");
}
