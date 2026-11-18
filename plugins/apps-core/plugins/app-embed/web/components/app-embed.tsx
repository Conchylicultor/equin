import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { RenderOrigin } from "@plugins/primitives/plugins/scope/plugins/render-origin/web";
import { Apps } from "@plugins/apps-core/web";
import {
  TabsProvider,
  useTabs,
  type EmbeddedAt,
  type EmbeddedTabSet,
} from "@plugins/apps-core/plugins/tabs/web";
import { AppTabsBody } from "@plugins/apps-core/plugins/tab-surface/web";
import {
  usePaneViews,
  type HistoryMode,
} from "@plugins/primitives/plugins/pane/web";
import { EMBED_PLACE_SURFACE } from "@plugins/primitives/plugins/pane/core";
import { withActiveRoutePrefix } from "@plugins/primitives/plugins/pane/plugins/route-prefix/web";
import { REVEAL_BOUNDARY_ATTR } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { useRecordBrandDrawn } from "@plugins/primitives/plugins/app-shell/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";

/** An app-rooted URL the embed was asked to open but cannot hold (no app in scope owns it). */
export type AppEmbedLeave = (url: string) => void;

/** The default `onLeave`: say so, and stay. */
function useRefuseLeave(): AppEmbedLeave {
  const toast = useToast();
  return () => {
    toast({
      type: "app-embed-leave-refused",
      title: "Opens outside this embed",
      description:
        "This app is embedded here; that destination is not part of it.",
      category: "confirmations",
    });
  };
}

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
 * - **Its place, in the page's URL — by itself.** Where the embed is (the
 *   focused tab's app-rooted URL under its surface mode's prefix) is the
 *   enclosing pane's embed tail: `<the page's URL>/at/<location>`
 *   (`pane/core`'s `splitEmbedTail`) — so a reload, a bookmark or a link
 *   comes back to it, and a host writes no URL code. A move rewrites the
 *   current history entry (the embed is a box on a page: Back leaves the
 *   page); Back / Forward that change the URL move the embed with it.
 *   Outside any pane (no address to hold it) the place is kept in memory
 *   only. One embed per pane instance: two would share the tail.
 * - **Its title, for the host to take.** `onTitleChange` is told the focused
 *   tab's title as the app's own tab is titled (`<Entity> — <App>`) as it
 *   changes, and `undefined` when the embed unmounts. A host page that is
 *   the embed while it shows (a demo) hands it to its own tab
 *   (`useClaimTabTitle`), so the browser tab follows the app inside; one
 *   that is not ignores it.
 * - **Never its host page's scroll.** Its box is a reveal boundary
 *   (`scroll-reveal`): a row revealing itself inside (a selected item, a
 *   deep link) scrolls the embed's own containers, never the page around it.
 * - **Its new browser tabs.** A ⌘-click or an Open in a new tab inside opens
 *   this page with the embed at that place — the same embed, never the real
 *   app at that path.
 *
 * A host that keeps the place elsewhere (in memory, in its own route) hands
 * a `place` binding instead ({@link EmbedPlaceBinding}) — one whose moves are
 * the page's history (the embed is the whole page) writes each with the
 * `history` mode it is told. Size it with `className` (it fills its box). `app` /
 * `route` seed the first tab when the URL names no place yet; with neither,
 * it opens on the composition's home app.
 */
export function AppEmbed({
  onLeave: onLeaveProp,
  fills,
  onTitleChange,
  className,
  place,
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
  /** Told the embed's title as it changes, `undefined` once it unmounts (see above). */
  onTitleChange?: (title: string | undefined) => void;
  /**
   * Where the host keeps the embed's place, when not in the enclosing pane's
   * embed tail (see {@link EmbedPlaceBinding}). Omitted: the pane's tail,
   * else (no pane) memory only.
   */
  place?: EmbedPlaceBinding;
  className?: string;
}): ReactNode {
  const refuseLeave = useRefuseLeave();
  const onLeave = onLeaveProp ?? refuseLeave;
  const fillsPage = fills !== undefined;
  // Filling the viewport, the embed's own brand (its floating launcher) holds
  // the page's top-left corner: the page draws no launcher of its own there.
  const pageSurface = useSurfaceTabId();
  useRecordBrandDrawn(fills === "viewport" ? pageSurface : undefined);
  const paneBinding = usePaneTailBinding();
  const binding = place ?? paneBinding;
  const location = binding?.location;
  // The seed is read once, at the tab set's first render: the host's place
  // first, else the host's app / route, else the composition's home app.
  const seed: EmbeddedAt =
    location !== undefined
      ? { url: location }
      : at.app !== undefined
        ? { app: at.app, route: at.route }
        : { url: undefined };
  const [embeddedAt] = useState(seed);
  const onLocationChange = binding?.onLocationChange;
  const browserTabUrl = binding?.browserTabUrl;
  const embedded = useMemo<EmbeddedTabSet>(
    () => ({
      at: embeddedAt,
      location,
      onLeave,
      fillsPage,
      ...(onLocationChange !== undefined && browserTabUrl !== undefined
        ? { onLocationChange, browserTabUrl }
        : {}),
    }),
    [embeddedAt, location, onLeave, fillsPage, onLocationChange, browserTabUrl],
  );
  return (
    <TabsProvider embedded={embedded}>
      <EmbedFrame
        className={className}
        viewport={fills === "viewport"}
        onTitleChange={onTitleChange}
      />
    </TabsProvider>
  );
}

/**
 * Where a host keeps its embed's place — the embed reads it and reports every
 * move to it, and addresses a new browser tab opened from inside through it.
 * The default binding is the enclosing pane's embed tail; a host whose embed
 * lives outside a pane (portaled from a layout), or whose place must not be
 * in the URL, hands its own.
 */
export interface EmbedPlaceBinding {
  /** Where the embed is, as the host keeps it (`undefined`: nowhere chosen yet). */
  location: string | undefined;
  /** Told each move (`history`: how the app's own tab would write it). */
  onLocationChange: (url: string, history: HistoryMode) => void;
  /** The URL of this origin a new browser tab opened at `place` from inside opens. */
  browserTabUrl: (place: string) => string;
}

/**
 * The enclosing pane's embed tail as a binding: a move rewrites the current
 * entry (the embed is a box on the page, not its history). `null` outside a
 * pane (the place is then kept in memory only).
 */
function usePaneTailBinding(): EmbedPlaceBinding | null {
  const views = usePaneViews();
  const location = views?.values[EMBED_PLACE_SURFACE];
  const latest = useLatestRef({ views, location });
  const onLocationChange = useCallback(
    (next: string) => {
      const now = latest.current;
      if (now.views === null || next === now.location) return;
      now.views.set({ [EMBED_PLACE_SURFACE]: next }, "replace");
    },
    [latest],
  );
  const browserTabUrl = useCallback(
    (place: string) => {
      const now = latest.current;
      if (now.views === null)
        throw new Error("An unbound embed addresses no browser tab.");
      return withActiveRoutePrefix(
        now.views.href({ [EMBED_PLACE_SURFACE]: place }),
      );
    },
    [latest],
  );
  const bound = views !== null;
  return useMemo(
    () => (bound ? { location, onLocationChange, browserTabUrl } : null),
    [bound, location, onLocationChange, browserTabUrl],
  );
}

/**
 * Where the embed opens when the page's URL names no place for it yet: an
 * app at its app-relative route (`/c/<id>`), or — neither given — the
 * composition's home app.
 */
export type AppEmbedAt =
  { app: string; route: string } | { app?: never; route?: never };

/** The embed's box, themed by the focused tab's app, holding the surface. */
function EmbedFrame({
  className,
  viewport,
  onTitleChange,
}: {
  className: string | undefined;
  viewport: boolean;
  onTitleChange: ((title: string | undefined) => void) | undefined;
}) {
  const { tabs, focusedTabId, titles } = useTabs();
  const surface = Apps.Surface.useContributions()[0];
  const apps = Apps.App.useContributions();
  const focusedApp = tabs.find((t) => t.tabId === focusedTabId)?.appId;
  // The focused tab's title as the app's own tab is titled: its content's,
  // then its app's name — each once.
  const title = [
    ...new Set([
      focusedTabId === undefined ? undefined : titles[focusedTabId],
      apps.find((a) => a.id === focusedApp)?.app.name,
    ]),
  ]
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" — ");
  const titleRef = useLatestRef(onTitleChange);
  useEffect(() => {
    titleRef.current?.(title === "" ? undefined : title);
  }, [title, titleRef]);
  useEffect(() => () => titleRef.current?.(undefined), [titleRef]);
  return (
    <Theme
      name={focusedApp === undefined ? undefined : appThemeScope(focusedApp)}
      surface="canvas"
      // Which app the embed shows, for a reader outside it (an e2e script).
      data-app-embed={focusedApp ?? ""}
      // A reveal inside scrolls the embed's containers, never its host page.
      {...{ [REVEAL_BOUNDARY_ATTR]: "" }}
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
