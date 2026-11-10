import { Fragment, useMemo, useState, type ReactNode } from "react";
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
  type EmbeddedAt,
  type EmbeddedTabSet,
} from "@plugins/apps-core/plugins/tabs/web";
import { AppTabsBody } from "@plugins/apps-core/plugins/tab-surface/web";
import type { HistoryMode } from "@plugins/primitives/plugins/pane/web";

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
 * - **Its own overlays** (`Apps.Overlay`, as the page's layout mounts them):
 *   floating chrome inside the tab state, resolved against the embed's box —
 *   the floating launcher, so an app that draws no brand of its own is not a
 *   dead end in a box with no rail or tab bar.
 *
 * - **The keyboard, when it is the page.** An embed inside a bigger page does
 *   not take the keyboard when it mounts — the user moves into it by pointing
 *   at it. One that `fills` the page (the page shows nothing but it) takes it
 *   at mount, as the app's own surface does, so its shortcuts answer at once.
 * - **Its location, for the host to keep.** `onLocationChange` is told the
 *   focused tab's app-rooted URL (under the surface mode's prefix) as it
 *   moves, and whether the app's own tab would have pushed a history entry
 *   for the move or replaced the current one; handed back as `url`, it
 *   reopens the embed there — a host page keeps it in its own URL, so a
 *   reload comes back to it. A `url` the host changes later (its page's Back
 *   / Forward) moves the open embed there.
 * - **Its new browser tabs.** A ⌘-click or an Open in a new tab inside opens
 *   `browserTabUrl(location there)` when given (the host's page showing the
 *   embed at that place), else the path on the host's origin (the real app).
 *
 * Size it with `className` (it fills its box). `app` / `route` seed the
 * first tab only; `url` seeds it and is then followed.
 */
export function AppEmbed({
  onLeave = refuseLeave,
  fills,
  onLocationChange,
  browserTabUrl,
  className,
  ...at
}: AppEmbedAt & {
  onLeave?: AppEmbedLeave;
  /**
   * The embed is all the page shows — it takes the keyboard when it mounts:
   * `"page"` in the page's own frame (a caption, a border: its top-right
   * corner is not the viewport's, so it hosts no floating action bar), or the
   * whole `"viewport"`, where its headers make room for and anchor the page's
   * floating action bar as the app's own surface does. Omitted: a box inside
   * a bigger page.
   */
  fills?: "page" | "viewport";
  /** See {@link EmbeddedTabSet.onLocationChange}. */
  onLocationChange?: (url: string, history: HistoryMode) => void;
  /** See {@link EmbeddedTabSet.browserTabUrl}. */
  browserTabUrl?: (url: string) => string;
  className?: string;
}): ReactNode {
  const fillsPage = fills !== undefined;
  // The seed is read once, at the tab set's first render.
  const seed: EmbeddedAt =
    at.app !== undefined ? { app: at.app, route: at.route } : { url: at.url };
  const [embeddedAt] = useState(seed);
  const location = at.url;
  const embedded = useMemo<EmbeddedTabSet>(
    () => ({
      at: embeddedAt,
      location,
      onLeave,
      fillsPage,
      onLocationChange,
      browserTabUrl,
    }),
    [embeddedAt, location, onLeave, fillsPage, onLocationChange, browserTabUrl],
  );
  return (
    <TabsProvider embedded={embedded}>
      <EmbedFrame className={className} viewport={fills === "viewport"} />
    </TabsProvider>
  );
}

/**
 * Where the embed opens: an app at its app-relative route (`/c/<id>`), or an
 * app-rooted URL as `onLocationChange` reports one (`/agents/c/x`,
 * `/desktop/sonata`) — `undefined`, or one no app in scope owns, opens the
 * composition's home app.
 */
export type AppEmbedAt =
  | { app: string; route: string; url?: never }
  | { url: string | undefined; app?: never; route?: never };

/** The embed's box, themed by the focused tab's app, holding the surface. */
function EmbedFrame({
  className,
  viewport,
}: {
  className: string | undefined;
  viewport: boolean;
}) {
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
      // anchor the global floating action bar. One filling the viewport is
      // that corner: its headers host the bar, as the app's own surface does.
      // eslint-disable-next-line layout/no-adhoc-layout -- the embed's own box: `relative isolate` contains its overlays and stacking, `transform-gpu` makes it the containing block for the app shell's fixed sidebar
      className={cn(
        "relative isolate size-full transform-gpu overflow-hidden",
        !viewport && "floating-bar-boundary",
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
          <EmbedOverlays />
        </PluginErrorBoundary>
      </RenderOrigin>
    </Theme>
  );
}

/** Every `Apps.Overlay` contribution, each isolated in its own boundary — the
 * embed's twin of the page layout's overlay host. */
function EmbedOverlays() {
  const overlays = Apps.Overlay.useContributions();
  return overlays.map((overlay) => (
    <Fragment key={overlay.id}>
      {renderIsolated(Apps.Overlay, overlay as unknown as Contribution, {})}
    </Fragment>
  ));
}
