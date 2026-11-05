import { useMemo, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { Apps } from "@plugins/apps-core/web";
import {
  TabsProvider,
  useTabs,
  type EmbeddedTabSet,
} from "@plugins/apps-core/plugins/tabs/web";
import { AppTabsBody } from "@plugins/apps-core/plugins/tab-surface/web";

/** An app-rooted URL the embed was asked to open but cannot hold (no app in scope owns it). */
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
 * The app, in-process, inside its own box: an EMBEDDED tab set
 * (`TabsProvider embedded`) and the same surface body the app's own layout
 * renders (`Apps.Surface`, else the docked-only `AppTabsBody`) — so a pane
 * open, Expand, an app switch and the desktop work in it as in the app. It
 * knows nothing about where its data comes from: around a `<DemoScope>` it
 * renders a demo, around nothing the real instance.
 *
 * - **Its own tab set.** One tab of `app` at `route` (app-relative, `/c/<id>`),
 *   in non-live pane stores that never read or write the page URL, history or
 *   storage, and publish none of the page's signals. The page's own tabs, mode
 *   and focused app are untouched by anything inside.
 * - **Its own navigation boundary** (the tab set's): a URL of an app in scope
 *   (`Apps.App` — inside a `<PluginScope>`, the composition's) moves the embed —
 *   the tab's route, or an in-tab app swap; one carrying a surface-mode app's
 *   base path (the Desktop's `/desktop`) switches the embed's surface mode,
 *   whose windows are then the embed's own tabs; anything else is
 *   `onLeave(url)` — by default a toast, and the embed stays.
 * - **Its own render origin** (`scope/render-origin`): a toast's body or an
 *   imperative dialog raised inside renders in the embed's tree — its tab set,
 *   theme and whatever transport and plugin scope surround it — not in the
 *   page chrome that shows it.
 * - **Its own theme scope**, `app:<id>` of the focused tab's app, with
 *   `transform-gpu` so `position: fixed` app chrome (a sidebar) resolves
 *   against the embed, not the viewport. A placement that would escape to the
 *   viewport (solo) fills the embed box instead — the embed is its viewport.
 *
 * Size it with `className` (it fills its box). `app` / `route` seed the first
 * tab only.
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
  // The seed is read once, at the tab set's first render.
  const embedded = useMemo<EmbeddedTabSet>(
    () => ({ app, route, onLeave }),
    [app, route, onLeave],
  );
  return (
    <TabsProvider embedded={embedded}>
      <EmbedFrame className={className} />
    </TabsProvider>
  );
}

/** The embed's box, themed by the focused tab's app, holding the surface. */
function EmbedFrame({ className }: { className: string | undefined }) {
  const { tabs, focusedTabId } = useTabs();
  const surface = Apps.Surface.useContributions()[0];
  const focusedApp = tabs.find((t) => t.tabId === focusedTabId)?.appId;
  return (
    <Theme
      name={focusedApp === undefined ? undefined : appThemeScope(focusedApp)}
      surface="canvas"
      // Which app the embed shows, for a reader outside it (an e2e script).
      data-app-embed={focusedApp ?? ""}
      // `floating-bar-boundary`: the embed is a box on its host's page, not
      // the viewport's top-right corner — its headers must not reserve or
      // anchor the global floating action bar.
      // eslint-disable-next-line layout/no-adhoc-layout -- the embed's own box: `relative isolate` contains its overlays and stacking, `transform-gpu` makes it the containing block for the app shell's fixed sidebar
      className={cn(
        "floating-bar-boundary relative isolate size-full transform-gpu overflow-hidden",
        className,
      )}
    >
      {/* The embed's render origin: a toast or dialog raised inside renders
          under its tab set (a link in it moves the embed) and app theme. */}
      <RenderOrigin>
        <PluginErrorBoundary label="App embed">
          {surface ? (
            renderIsolated(Apps.Surface, surface as unknown as Contribution, {})
          ) : (
            <AppTabsBody />
          )}
        </PluginErrorBoundary>
      </RenderOrigin>
    </Theme>
  );
}
