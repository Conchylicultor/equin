import { Fragment, useEffect } from "react";
import {
  useDeferredLoadState,
  useHasLoadErrorUnder,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  TooltipProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  setBasePath,
  useSyncPaneRegistry,
  useRenderSync,
} from "@plugins/primitives/plugins/pane/web";
import type { RailFramingProps } from "@plugins/apps-core/core";
import {
  Apps,
  useActiveApp,
  usePathname,
  defaultApp,
  matchAppForPath,
} from "@plugins/apps-core/web";
import {
  TabsProvider,
  useTabs,
  appLinkProps,
} from "@plugins/apps-core/plugins/tabs/web";
import { AppTabsBody } from "@plugins/apps-core/plugins/tab-surface/web";
import { isChromelessDocument } from "@plugins/primitives/plugins/embed/web";
import { resolveUnmatchedUrl } from "../internal/unmatched-url";

/**
 * Replace the URL and notify the router/pathname subscribers.
 *
 * The existing `history.state` is PRESERVED, never overwritten with `{}`: an
 * entry is a complete snapshot (`{ tabId, appId, appInstance, route|pending }`)
 * and blanking it strands the entry — the shell adapter falls back to URL
 * reparsing, and a later cold boot can no longer tell which app instance the
 * entry belonged to.
 *
 * Preserving is safe here because this redirect only fires on bare `/`, where
 * `bootTabs` already resolved `urlAppId` through the `seedAppId` →
 * `defaultApp(apps)` fallback (`use-tabs.tsx:247-248`) — the very app
 * `defaultPath` points at. So the preserved `appId` already agrees with the
 * post-redirect URL, and the preserved route is `[]`/pending (an unmatched URL
 * seeds no resolved route). Nothing stale survives the rewrite.
 */
function redirectTo(url: string) {
  window.history.replaceState(window.history.state ?? {}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.dispatchEvent(new CustomEvent("shell:navigate"));
}

/**
 * Import-free fallback when no `Apps.RailFraming` contributor is loaded: no
 * rail, `body` fills the full width. Rail chrome is opt-in via `Apps.RailFraming`
 * — a filtered composition that never selects a rail-framing variant gets this
 * railless surface. The `--app-rail-width: 0px` keeps the rail-width var
 * consistent for any downstream reader (mirrors `app-rail-framing/hidden`).
 */
function RaillessFraming({ body }: RailFramingProps) {
  return (
    <Stack
      direction="row"
      gap="none"
      className="h-full min-h-0"
      style={{ "--app-rail-width": "0px" } as React.CSSProperties}
    >
      {body}
    </Stack>
  );
}

/**
 * Mirrors the focused tab's content title into the browser document title
 * (`<Entity> — <App> — Equin`), reusing the same per-tab titles the tab
 * bar shows. One global sync, so the browser tab name is never the stale static
 * "Equin".
 */
function DocumentTitleSync() {
  const { tabs, focusedTabId, titles } = useTabs();
  const apps = Apps.App.useContributions();
  const focused = tabs.find((t) => t.tabId === focusedTabId);
  const appName = apps.find((a) => a.id === focused?.appId)?.app.name;
  const entity = focused ? titles[focused.tabId] : undefined;
  useEffect(() => {
    document.title = [entity, appName, "Equin"].filter(Boolean).join(" — ");
  }, [entity, appName]);
  return null;
}

export function AppsLayout() {
  const activeApp = useActiveApp();
  const pathname = usePathname();
  const apps = Apps.App.useContributions();
  const { deferredComplete } = useDeferredLoadState();
  // Coarse by design: when ANY app shell's subtree failed to load, the URL→app
  // mapping is unknowable (a failed shell never registered its path), so a load
  // error anywhere under the apps tier suppresses the destructive redirect. The
  // safe failure direction — preserve the URL, show the error surface.
  const anyAppShellLoadError = useHasLoadErrorUnder("apps/plugins/");

  // This decision must stay URL-driven: it judges the address bar itself (does
  // any app own this path?), so its "matched" signal is `matchAppForPath(pathname)`.
  // NOT `useActiveApp()`, which derives from the FOCUSED TAB's app (the snapshot
  // model) and would report a match even on an unmatched URL — reporting "all
  // fine" on exactly the broken links this is here to catch. Chrome identity
  // (theme/rail) legitimately follows the focused tab via `activeApp`; URL
  // adjudication legitimately follows the URL — kept apart.
  const urlMatchedId = matchAppForPath(pathname, apps)?.id;
  const fallbackApp = defaultApp(apps);
  const defaultPath = fallbackApp?.app.basePath;

  // ONE rule decides both the redirect and what the tabs area paints, so the two
  // can never disagree (see `resolveUnmatchedUrl` for the full case table).
  const outcome = resolveUnmatchedUrl({
    matched: !!urlMatchedId,
    hasDefault: !!defaultPath,
    isBareRoot: pathname === "/",
    deferredComplete,
    anyAppShellLoadError,
  });

  // Canonicalize bare `/` to the default app (the one declaring `default: true`,
  // else the only/first registered app). This is the ONLY raw `replaceState`
  // redirect in the app, and it is DESTRUCTIVE — it overwrites the address bar —
  // so it fires ONLY where there is nothing to destroy. A non-bare unmatched
  // path is a broken link, not a path to canonicalize: it keeps its URL and gets
  // the not-found surface below.
  useEffect(() => {
    if (outcome === "redirect") redirectTo(defaultPath!);
  }, [outcome, defaultPath]);

  const basePath = activeApp?.app.basePath ?? "";

  // Populate the global pane registry here, at the apps root, rather than
  // relying on the active app's layout renderer to do it. The registry reflects
  // *all* registered panes app-wide — a global invariant, not a per-renderer
  // concern. Syncing it here means a global action that opens a pane (e.g. the
  // theme customizer) can never throw "Unknown pane", even in an app whose
  // surface mounts no pane renderer. Renderers still re-sync (idempotent) and
  // own how an opened pane actually paints. This drives the *live* store (the
  // focused tab's), which `setBasePath`/`useSyncPaneRegistry` target.
  useRenderSync(() => {
    setBasePath(basePath);
  }, [basePath]);
  useSyncPaneRegistry();

  // TooltipProvider stays outermost — AppRail uses WithTooltip and must sit
  // inside it; harmless over the rail-less `hidden` variant. TabsProvider wraps
  // the tab bar + framing so the rail's open-or-focus and the tab bar both read
  // the same tab state. The tab bar owns the full width at the top; the
  // rail-framing (rail + tab body) fills the area beneath it — so the rail sits
  // *below* the tab bar, not above it.
  return (
    <TooltipProvider delay={300}>
      <TabsProvider>
        <DocumentTitleSync />
        <Stack gap="none" className="h-full min-h-0">
          <TabBarHost />
          {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible fill leaf below the rigid tab bar; bounds the framed surface's own scroll */}
          <div className="min-h-0 min-w-0 flex-1">
            {outcome === "load-error" ? (
              <AppLoadErrorSurface />
            ) : outcome === "not-found" ? (
              <NoSuchRouteSurface
                pathname={pathname}
                defaultPath={defaultPath}
                defaultName={fallbackApp?.app.name}
              />
            ) : outcome === "loading" ? (
              <Center className="size-full">
                <Loading variant="spinner" label="Loading…" />
              </Center>
            ) : (
              <FramedSurface />
            )}
          </div>
        </Stack>
        <OverlayHost />
      </TabsProvider>
    </TooltipProvider>
  );
}

/**
 * Shown in the tabs area when the default-app redirect is suppressed because an
 * app shell failed to load (settled + unhealthy). We never destroy the URL in
 * this state, so the user gets a plain Retry (full reload) instead of a silent
 * jump to the homepage. Mirrors the route-fallback plugin's app-load-error copy.
 */
function AppLoadErrorSurface() {
  return (
    <Center className="size-full">
      <Stack gap="sm" align="center">
        <Stack gap="2xs" align="center">
          <Text variant="heading">Couldn't load the app</Text>
          <Text variant="body" tone="muted">
            Part of the app failed to load. Reloading usually fixes it.
          </Text>
        </Stack>
        <Button variant="outline" onClick={() => location.reload()}>
          Retry
        </Button>
      </Stack>
    </Center>
  );
}

/**
 * Shown when the URL matches no registered app and the tier has settled healthy
 * — i.e. no app will ever own this path. The address bar is deliberately left
 * intact: this replaces a silent `replaceState` to the homepage, whose whole
 * problem was destroying the evidence. The offending path is echoed back because
 * it is the one actionable detail (a link that lost its app prefix, e.g.
 * `/tasks/t/<id>` instead of `/agents/tasks/t/<id>`, is only diagnosable if the
 * user can still see it).
 *
 * The way out is the sanctioned `navigate()` (through `appLinkProps`, so a
 * ⌘/middle-click opens it in a new browser tab), not another raw history
 * write, so leaving is a real navigation that mints its own history entry.
 */
function NoSuchRouteSurface({
  pathname,
  defaultPath,
  defaultName,
}: {
  pathname: string;
  defaultPath: string | undefined;
  defaultName: string | undefined;
}) {
  return (
    <Center className="size-full">
      <Stack gap="sm" align="center" className="max-w-md">
        <Stack gap="2xs" align="center">
          <Text variant="heading">This page doesn't exist</Text>
          <Text variant="body" tone="muted">
            No installed app handles this address. The link may be outdated or
            mistyped.
          </Text>
        </Stack>
        <Badge mono title={pathname}>
          {pathname}
        </Badge>
        {defaultPath ? (
          <Button variant="outline" {...appLinkProps(defaultPath)}>
            Go to {defaultName ?? "the home app"}
          </Button>
        ) : null}
      </Stack>
    </Center>
  );
}

/** Renders the tab strip via the `Apps.TabBar` slot; nothing when no
 * contributor is present (chrome-less surface — the tab bar is opt-in), and
 * nothing in a chromeless embed (`?embed=1`, see `primitives/embed`): the
 * frame around it is someone else's chrome. An embed that keeps its chrome
 * (`?embed=chrome`) draws it. */
/** Every `Apps.Overlay` contribution, each isolated in its own boundary. */
function OverlayHost() {
  const overlays = Apps.Overlay.useContributions();
  return overlays.map((overlay) => (
    <Fragment key={overlay.id}>
      {renderIsolated(Apps.Overlay, overlay as unknown as Contribution, {})}
    </Fragment>
  ));
}

function TabBarHost() {
  const tabBar = Apps.TabBar.useContributions()[0];
  if (isChromelessDocument()) return null;
  return tabBar
    ? renderIsolated(Apps.TabBar, tabBar as unknown as Contribution, {})
    : null;
}

/** Renders the surface body inside the active rail-framing variant. */
function FramedSurface() {
  const framing = Apps.RailFraming.useContributions()[0];
  const surface = Apps.Surface.useContributions()[0];
  // The `surface` plugin owns the multi-placement body; with no contributor,
  // `apps` degrades to its built-in docked-only strip.
  const body = surface ? (
    renderIsolated(Apps.Surface, surface as unknown as Contribution, {})
  ) : (
    <AppTabsBody />
  );
  const props: RailFramingProps = { body };
  // A chromeless embed takes the railless path whatever variant is
  // configured: the rail is app chrome, and a chromeless embed has none.
  return framing && !isChromelessDocument() ? (
    renderIsolated(Apps.RailFraming, framing as unknown as Contribution, props)
  ) : (
    <RaillessFraming {...props} />
  );
}
