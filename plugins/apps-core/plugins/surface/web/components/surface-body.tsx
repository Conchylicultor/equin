import { useSlotOrder } from "@plugins/primitives/plugins/slot-render/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Activity,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { TabSurface } from "@plugins/apps-core/plugins/tab-surface/web";
import { setFocusedSurfaceId } from "@plugins/primitives/plugins/shortcuts/web";
import {
  claimTabSet,
  useTabs,
  usePlacementRegistry,
  type Tab,
} from "@plugins/apps-core/plugins/tabs/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { useViewportEscape } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import {
  Surface,
  PlacementStyleProvider,
  type PlacementDef,
  type PlacementFrame,
  type PlacementStyleApi,
} from "../slots";
import { useTabPresence } from "../internal/use-tab-presence";

/**
 * The one place a {@link PlacementFrame} role becomes CSS. A mode declares the
 * role; this host owns the mechanics, so the two can never drift apart and a
 * mode cannot spell a geometry the host does not know how to unwind.
 *
 * - `pane` — fills the surface box it is rendered in.
 * - `window` — a free box positioned by the mode's own `Chrome` (floating's
 *   geometry push). `overflow-hidden` is part of the ROLE, not one mode's taste:
 *   a window frame that leaks past its own rounded corner is a bug in every
 *   conceivable window mode.
 * - `viewport` — `fixed`, against the real window. `z-overlay` and NOT `z-max`:
 *   with the backdrop's transform dropped (see `escapesSurface` below) the
 *   container sits in the ROOT stacking context, alongside every body-portaled
 *   popover, so a higher band would paint its opaque background over every
 *   popover/dropdown/dialog opened from inside the fullscreen app. `z-overlay`
 *   still covers all app chrome (`z-nav`) and the surface backdrop, and
 *   `z-popover` overlays still paint above it.
 *
 * It is a module const rather than an inline class literal for the same reason
 * `<ViewportOverlay>`'s own recipe is: this module is the OWNER of these
 * mechanics, and an owner is exempt from the `no-adhoc-*` rules that redirect
 * everyone else to it — but the exemption is now WRITTEN, at the one place this
 * map is read. It used to be implicit: the rules harvested literals only from
 * class-name attributes and `cn()` arguments, so a map read through an
 * identifier was invisible to them and needed no disable. That blind spot is
 * closed (the shared class-token walk follows same-file aliases), which is the
 * right outcome — an owner should say it owns the mechanics rather than be
 * silently unreachable, since nothing distinguished this map from one that had
 * simply escaped.
 */
const FRAME_CLASS: Record<PlacementFrame, string> = {
  pane: "absolute inset-0",
  window: "absolute overflow-hidden",
  viewport: "fixed inset-0 z-overlay",
};

/** A kept-alive tab that is not shown — see `TabContainer`'s visibility gate. */
const HIDDEN_TAB: CSSProperties = {
  contentVisibility: "hidden",
  clipPath: "inset(50%)",
};

/**
 * The single surface body that renders EVERY open tab at once and positions each
 * by its own per-tab placement. There is no global arrangement mode — the surface
 * looks however the active placements paint it (docked tabs full-bleed, floating
 * windows over a backdrop, a solo tab full-app). Contributed into `Apps.Surface`;
 * mounted inside `TabsProvider`, so it reads `useTabs()` directly.
 *
 * This body is GENERIC: it names no specific placement. Every placement (docked /
 * floating / solo …) is a self-contained sub-plugin contributing one
 * {@link PlacementDef} to the `Surface.Placement` registry; this dispatcher
 * resolves each tab through the matching descriptor and varies only data
 * (class / chrome / backdrop). One stable container per tab, rendered at the same
 * tree position as the same element type under an unchanged parent chain, keeps
 * each `TabSurface` mounted across a mode switch (Chrome-style keep-alive).
 */
export function SurfaceBody() {
  // The slot's layout order: the fallback default and "the first other mode".
  // Not known yet is a state, never the raw registration order: nothing below
  // — the tabs, and above all the published placement capabilities — exists
  // until it is. Publishing a capability set derived from a partial order would
  // make the theme's root scope "known" on a wrong answer.
  const order = useSlotOrder(Surface.Placement);
  switch (order.status) {
    case "loading":
      return (
        <Center className="size-full">
          <Loading variant="spinner" label="Loading…" />
        </Center>
      );
    case "error":
      // The last-known layout keeps the SAME element as the ready arm, so a
      // failed refresh never remounts the open tabs.
      return order.stale === undefined ? (
        <Center className="size-full">
          <ResourceErrorInline
            error={order.error}
            refetch={order.refetch}
            variant="block"
            subject="the surface layout"
          />
        </Center>
      ) : (
        <SurfaceBodyReady sorted={order.stale} />
      );
    case "ready":
      return <SurfaceBodyReady sorted={order.data} />;
  }
}

/**
 * The placements this tab set can show — every one, in every tab set. A
 * `viewport` frame means "the tab set's own viewport": the window for the
 * page's set, and its box for a contained one (an `AppEmbed`'s, whose
 * `transform-gpu` makes it the containing block). So in a contained set a
 * `viewport`-framed placement (solo) renders as a `pane` that fills the box —
 * nothing escapes, so the backdrop keeps its transform and the escape audit has
 * nothing to check — and it is not the set's boot mode: a box opens as a box
 * on someone else's page, and filling it is the user's gesture (a window's Full
 * screen), never what it boots into.
 */
function useAvailablePlacements(sorted: readonly PlacementDef[]): {
  placements: readonly PlacementDef[];
  defaultId: string;
} {
  const { contained } = useTabs();
  return useMemo(() => {
    // A box with nothing but viewport placements still opens in one of them.
    const boxed = sorted.filter((d) => d.frame !== "viewport");
    const opensIn = contained && boxed.length > 0 ? boxed : sorted;
    return {
      placements: contained
        ? sorted.map((d) =>
            d.frame === "viewport" ? { ...d, frame: "pane" as const } : d,
          )
        : sorted,
      defaultId: opensIn.find((d) => d.default)?.id ?? opensIn[0]?.id ?? "",
    };
  }, [contained, sorted]);
}

/** The surface once its placement order is known — see {@link SurfaceBody}. */
function SurfaceBodyReady({
  sorted: allSorted,
}: {
  /** The `Surface.Placement` contributions, in the slot's layout order. */
  sorted: readonly PlacementDef[];
}) {
  const { placements: sorted, defaultId } = useAvailablePlacements(allSorted);
  const {
    id: tabSetId,
    tabs,
    focusedTabId,
    focusTab,
    closeTab,
    mode,
    exitToPreviousMode,
    titles,
  } = useTabs();

  const byId = useMemo(() => {
    const m = new Map<string, PlacementDef>();
    for (const d of sorted) m.set(d.id, d);
    return m;
  }, [sorted]);

  // Publish the derived capabilities to the apps-owned registry so apps-side
  // chrome (tab bar `+`, theme scope, use-tabs default) can read them back
  // without ever importing or naming a specific mode. Direction stays
  // surface → apps (apps never imports surface). The registration hands back a
  // disposer that restores the previous capabilities, so this body un-publishes
  // itself when it unmounts instead of leaving a dead set installed.
  const registry = usePlacementRegistry();
  useEffect(
    () =>
      registry.install({
        defaultId,
        ids: new Set(sorted.map((d) => d.id)),
        newTabFollows: new Set(
          sorted.filter((d) => d.newTabFollows).map((d) => d.id),
        ),
        appThemeScope: new Set(
          sorted.filter((d) => d.themeScope === "app").map((d) => d.id),
        ),
        ownsChrome: new Set(
          sorted.filter((d) => d.ownsChrome).map((d) => d.id),
        ),
        allowsEmpty: new Set(
          sorted.filter((d) => d.allowsEmpty).map((d) => d.id),
        ),
      }),
    [sorted, defaultId, registry],
  );

  // The ONE active mode descriptor: the surface renders EVERY tab under it.
  // Resolve the stored mode id to a registered descriptor, falling back to the
  // default for the pre-registration "" seed or a removed mode sub-plugin. This
  // single value is why two modes can never be visible at once — there is no
  // per-tab placement to disagree with it.
  const activeDef = byId.get(mode) ?? byId.get(defaultId);
  const enteredFrom = useEnteredFrom(allSorted, activeDef);

  // Exit-presence layer (view-only): the live tabs plus any just-closed tab,
  // retained so the active mode's Chrome can play an exit tween (only when the
  // mode declares an `exitDurationMs`, e.g. windows) before the host truly
  // unmounts it. Drives the render loop so a closing window animates out.
  const presence = useTabPresence(tabs, activeDef);
  const liveIds = presence.filter((p) => !p.exiting).map((p) => p.tab.tabId);
  const retainedIds = presence.map((p) => p.tab.tabId);

  // The modes whose own surfaces (Backdrop / Foreground / per-tab Chrome) are
  // mounted: every mode the surface has been in, in the slot's order. A mode's
  // surfaces mount the first time it is active and then STAY mounted, so a
  // mode switch is a visibility change on elements that already exist — never
  // the teardown and rebuild of a wallpaper, a shelf and every window's chrome.
  // Only the active one is shown; see `ModeActivity` for what "hidden" means.
  const mounted = useMountedModes(sorted, activeDef);

  // A placement whose containers are `fixed` (solo) needs the whole window AND
  // needs to out-paint the chrome beside the surface — see the class below. This
  // is the SINGLE fact behind both consequences (the dropped `transform-gpu` and
  // the runtime audit), read off the same `frame` role that produced the `fixed`
  // in the first place — so forgetting one of them has no spelling.
  const escapesSurface = activeDef?.frame === "viewport";
  const backdropRef = useRef<HTMLElement>(null);

  // Both of those promises are made by ancestors, up to <html>, across plugin
  // boundaries, and are only checkable once rendered. So check them, and fail
  // loudly: one failure is a fullscreen app that is 40px short, the other is a
  // fullscreen app with the rail still down the side, and both survive review.
  // Runs on activation only — a placement change, not a render.
  //
  // The walk itself is `viewport-overlay`'s: it is pure CSS and knows nothing
  // about tabs or placements. What the surface contributes is the two strings —
  // what the user loses, and what to do instead. `from` defaults to "self"
  // because this backdrop is the ANCESTOR being audited, not the fixed box.
  useViewportEscape(backdropRef, {
    enabled: escapesSurface,
    subject: "a fullscreen (solo) tab",
    remedy:
      "Remove the property, or scope it below the surface — a fullscreen tab must cover the whole window and out-paint the chrome beside it (the app rail's z-nav).",
  });

  return (
    // The shared backdrop for all modes. `relative` is what docked's `absolute
    // inset-0` and floating's geometry box resolve against, so it is
    // unconditional. `transform-gpu` is NOT about them: what it buys is stacking
    // isolation, keeping the surface's own painting out of the root stacking
    // context — which is also why a docked tab paints BELOW the app rail. It is
    // dropped for a `viewport`-framed placement, and both halves of that matter:
    // a transform would make this element the containing block for the
    // placement's `fixed` containers (clipping a fullscreen tab to the content
    // area) AND trap their `z-overlay` inside the surface's own stacking layer
    // (so it would lose to the rail's `z-nav`). Nothing inside can leak while it
    // is dropped: solo declares no Backdrop/Foreground, a mounted inactive
    // mode's are `display:none` (`ModeActivity`), and every unfocused tab is skipped and clipped away (`HIDDEN_TAB`). (An app's OWN `fixed` chrome stays bounded by the
    // per-tab content inset below, a different transform, in every mode.)
    //
    // No theme boundary here — the backdrop inherits the desktop `:root` theme.
    // Each forked app's scope block is mounted centrally (theme-engine's
    // AppScopeThemes at Core.Root); each tab container is a `<Theme>` naming
    // `app:<id>`, which is what picks it up.
    <Clip
      ref={backdropRef}
      // Pointing anywhere on this surface — a window, or the bare desktop of
      // an empty one — puts the user in this tab set: out-of-tree callers (a
      // shortcut) act on it (`peekFocusedTabSet()`).
      onPointerDownCapture={() => claimTabSet(tabSetId)}
      className={cn(
        "relative h-full w-full bg-background",
        !escapesSurface && "transform-gpu",
      )}
    >
      {/* Each mounted mode's optional backdrop (e.g. windows' desktop
          wallpaper); only the active mode's is shown. */}
      {mounted.map(
        (d) =>
          d.Backdrop && (
            <ModeActivity key={d.id} active={d === activeDef}>
              <d.Backdrop />
            </ModeActivity>
          ),
      )}
      {presence.map((p) => (
        <TabContainer
          key={p.tab.tabId}
          def={activeDef}
          mounted={mounted}
          tab={p.tab}
          focused={p.tab.tabId === focusedTabId}
          exiting={p.exiting}
          title={titles[p.tab.tabId]}
          onFocus={() => focusTab(p.tab.tabId)}
          onClose={() => closeTab(p.tab.tabId)}
          onExit={exitToPreviousMode}
          enteredFrom={enteredFrom}
        />
      ))}
      {/* Each mounted mode's optional foreground (e.g. windows' dock), rendered
          last so it sits above the tab containers; only the active mode's is
          shown. Gets the tabIds so it stays decoupled from the host — in a
          single mode, that's all the tabs. */}
      {mounted.map(
        (d) =>
          d.Foreground && (
            <ModeActivity key={d.id} active={d === activeDef}>
              <d.Foreground
                // LIVE ids only: the dock chip disappears immediately on close,
                // and a closing window can't be cycled / docked while it
                // animates out.
                tabIds={liveIds}
                // LIVE + EXITING ids: store-prune keys on this so a window is
                // not pruned out from under its still-animating Chrome.
                retainedTabIds={retainedIds}
              />
            </ModeActivity>
          ),
      )}
    </Clip>
  );
}

/**
 * The modes whose own surfaces are mounted: the active one plus every one the
 * surface has been in before, in the slot's layout order. Lazy — a mode the
 * user never visits (the desktop, for a session spent in solo) mounts nothing,
 * not even a hidden wallpaper — and sticky: once visited, a mode's surfaces
 * stay mounted until its placement is unregistered. Recorded by id, so the
 * contained set's remapped descriptors (see {@link useAvailablePlacements})
 * are the same modes.
 */
function useMountedModes(
  sorted: readonly PlacementDef[],
  activeDef: PlacementDef | undefined,
): readonly PlacementDef[] {
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set(activeDef ? [activeDef.id] : []),
  );
  // Adjusting state from a changed input during render (React's documented
  // pattern for it): the newly active mode mounts in the SAME commit that
  // shows it, never one render late.
  if (activeDef && !visited.has(activeDef.id))
    setVisited(new Set([...visited, activeDef.id]));
  return useMemo(
    () => sorted.filter((d) => d === activeDef || visited.has(d.id)),
    [sorted, activeDef, visited],
  );
}

/**
 * The frame the surface was in before the active mode — what each Chrome is
 * handed as `enteredFrom`. Read off the DECLARED descriptors (`allSorted`, not
 * the contained set's remap): `viewport` keeps meaning "the tab covered its
 * tab set's whole viewport", which in a contained set is its box. Updated in
 * render (React's adjust-state-on-input pattern), so the commit that shows the
 * new mode already carries where it came from.
 */
function useEnteredFrom(
  declared: readonly PlacementDef[],
  activeDef: PlacementDef | undefined,
): PlacementFrame | undefined {
  const [trail, setTrail] = useState<{
    id: string | undefined;
    enteredFrom: PlacementFrame | undefined;
  }>(() => ({ id: activeDef?.id, enteredFrom: undefined }));
  if (activeDef?.id !== trail.id)
    setTrail({
      id: activeDef?.id,
      enteredFrom: declared.find((d) => d.id === trail.id)?.frame,
    });
  return trail.enteredFrom;
}

/**
 * One mode's own surface (its Backdrop, its Foreground, or its Chrome for one
 * tab), kept mounted whether or not the mode is active. A React `<Activity>`:
 * while the mode is inactive its subtree keeps its state and its DOM, but its
 * host nodes are `display: none` (nothing of it paints, hit-tests, or overlaps
 * the active mode — what solo promises) and its EFFECTS are torn down — the
 * same lifecycle a mode's surfaces have always had, so whatever a mode does
 * "while shown" (a shortcut bridge, a hint anchor, a store reconcile, the
 * Chrome's pushed container style) still only happens while it is shown, with
 * no `active` flag for a mode to forget to read. Showing it again re-runs the
 * effects on the existing tree instead of building one.
 */
function ModeActivity({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <Activity mode={active ? "visible" : "hidden"}>{children}</Activity>;
}

interface TabContainerProps {
  /** The ONE active surface-mode descriptor (undefined => empty registry). */
  def: PlacementDef | undefined;
  /** Every mode whose surfaces are mounted — each one's `Chrome` is, too. */
  mounted: readonly PlacementDef[];
  tab: Tab;
  focused: boolean;
  /** True while this tab has left the store but is retained for its exit tween. */
  exiting: boolean;
  title: string | undefined;
  onFocus: () => void;
  onClose: () => void;
  /** Return the surface to the previous mode (passed to the mode's Chrome). */
  onExit: () => void;
  /** The frame the surface was in before the active mode (to each Chrome). */
  enteredFrom: PlacementFrame | undefined;
}

/**
 * One tab's stable keep-alive container. The container `<Theme>` (a `<div>`
 * carrying the tab's theme scope, its portal forward and the app canvas) and the
 * content inset → `TabSurface` chain below it are byte-identical across every
 * placement, so a placement change restyles the still-mounted tab rather than
 * remounting it. Only the container's class / inline style / the presence of a
 * sibling `Chrome` overlay change.
 *
 * That is the whole mechanism, and it is fragile in one specific way: React
 * reconciles by position AND element type, so returning this container wrapped
 * in anything conditional — a portal above all, whose identity is its container
 * node — reads as a different child and deletes the subtree. Every placement is
 * therefore expressed as CSS on the container that is already here; a placement
 * that needs to escape an ancestor says so with `frame: "viewport"` and the host
 * changes the ANCESTOR, never where the tab renders.
 *
 * The active placement's optional `Chrome` is a SIBLING overlay (never a parent
 * of `TabSurface`). It pushes dynamic inline style (floating's geometry box /
 * inset) and a raise-to-front pointer handler up to this container via the
 * keep-alive style channel ({@link PlacementStyleApi}); on unmount its cleanup
 * clears them, so docked / solo fall back to the static defaults.
 */
function TabContainer({
  def,
  mounted,
  tab,
  focused,
  exiting,
  title,
  onFocus,
  onClose,
  onExit,
  enteredFrom,
}: TabContainerProps) {
  // Dynamic style pushed by the active placement's `Chrome` (null for static
  // placements like docked / solo). These are the keep-alive override channel.
  const [overrideStyle, setOverrideStyle] = useState<CSSProperties | null>(
    null,
  );
  const [insetStyle, setInsetStyle] = useState<CSSProperties | null>(null);
  const [placementHidden, setPlacementHidden] = useState(false);
  const [pointerDownCapture, setPointerDownCapture] = useState<
    ((e: PointerEvent) => void) | null
  >(null);

  // Stable style channel for the active `Chrome`. The setter for the pointer
  // handler stores the function itself (not a state-updater), so we wrap it.
  const styleApi = useMemo<PlacementStyleApi>(
    () => ({
      setContainerStyle: (s) => setOverrideStyle(s),
      setContentInsetStyle: (s) => setInsetStyle(s),
      setContainerHidden: (h) => setPlacementHidden(h),
      setContainerPointerDownCapture: (h) => setPointerDownCapture(() => h),
    }),
    [],
  );

  // The container's class is the active mode's FRAME role resolved to mechanics,
  // plus whatever extra frame chrome the mode asks for (floating's rounded
  // border). The app's canvas is NOT in here any more — the `<Theme>` boundary
  // below paints it, for every mode and for the empty registry alike, so a mode
  // can no longer ship a themed container that paints nothing. Empty registry
  // (no mode plugins) is therefore not a separate branch at all: it is simply
  // the `pane` frame with no extra chrome, so the app stays usable and looks
  // docked-like. The control renders nothing.
  // eslint-disable-next-line layout/no-adhoc-layout, viewport-overlay/no-adhoc-viewport-overlay -- FRAME_CLASS is the frame recipe ITSELF: this host is what the layout/viewport primitives redirect a placement to, so it owns the positioning mechanics (see FRAME_CLASS above)
  const containerClassName = cn(
    FRAME_CLASS[def?.frame ?? "pane"],
    def?.frameClassName,
  );
  const visibleWhenUnfocused = def?.visibleWhenUnfocused ?? false;

  // Every tab stays mounted (keep-alive); only the visibility gate changes. A
  // mode that paints all tabs (`visibleWhenUnfocused`, i.e. windows) shows every
  // tab; docked / solo show only the focused one, so a non-focused tab is
  // hidden and can never overlap the visible one.
  //
  // Hidden is `content-visibility: hidden`, not `display: none`: the browser
  // skips the subtree (no paint, no hit-testing, no focus, out of the
  // accessibility tree) but KEEPS its styles and layout, so showing it again —
  // leaving full screen back to a desktop of several windows, or switching to a
  // docked tab — reuses them instead of restyling the whole app from scratch
  // (~20k elements a Sonata tab, measured with the desktop's fullscreen-switch
  // profile: 86k elements restyled on exit with 3 extra windows → ~3k). It
  // only pays off because nothing invalidates a hidden tab's styles on a mode
  // switch any more — the root theme stays put, and the floating bar's
  // safe-area rule no longer restyles under a `floating-bar-boundary` toggle.
  // A new whole-subtree invalidation there would bring the cost back, as a
  // forced restyle of every hidden tab (measure with that profile).
  //
  // The container box itself is not skipped — it would still paint the app's
  // canvas and catch the pointer over the visible tab (every solo tab is the
  // same `fixed inset-0`) — so it is also clipped away. `clip-path`, not
  // `visibility` / `pointer-events`: those inherit, and flipping one restyles
  // every element below.
  //
  // The active placement may hide a tab the gate shows (`setContainerHidden`:
  // a minimized window, an inactive group member, a window on another virtual
  // desktop) — the same way, so restoring a minimized window reuses its styles
  // too (~20k elements a Sonata window).
  const visible = (visibleWhenUnfocused || focused) && !placementHidden;

  // The host ALWAYS owns focus-on-pointerdown (harmless for every mode); the
  // active mode may ADD behavior (windows' raise-to-front) via the registered
  // `pointerDownCapture`, composed after the base focus.
  // It also claims the page's focused surface: with several tab sets on the
  // page (an `AppEmbed` beside the app's own), the tab pointed at is the one
  // keyboard shortcuts act on, even when it already was its set's focused tab.
  const onContainerPointerDownCapture = (e: PointerEvent) => {
    setFocusedSurfaceId(tab.tabId);
    onFocus();
    pointerDownCapture?.(e);
  };

  return (
    <Theme
      // The tab IS the app's theme boundary, all three halves at once: the scope
      // tag the matching `ScopedAppTheme` block selects on, the portal forward
      // that carries it to popovers opened out of the subtree, and — the half
      // every placement used to have to remember in its own paint class — the
      // app's own canvas under it.
      name={`app:${tab.appId}`}
      surface="canvas"
      onPointerDownCapture={onContainerPointerDownCapture}
      // Which tab this box IS. The theme scope is an app-level tag that
      // cross-app chrome (the tab strip, the rail) wears too, so it cannot name
      // one tab's container; anything asking "where does tab X live on screen"
      // — a debug overlay, the e2e that proves a mode switch never moved it —
      // needs this one.
      data-tab-id={tab.tabId}
      className={containerClassName}
      style={{ ...(visible ? null : HIDDEN_TAB), ...overrideStyle }}
    >
      {/* Stable content inset: ALWAYS present so `TabSurface`'s parent chain is
          identical in every placement. Only its CSS changes (pushed by the active
          Chrome — e.g. floating's titlebar inset). The portal
          forward that used to sit between this box and `TabSurface` is gone from
          here: `<Theme>` above renders it, unconditionally and with the same
          per-tab scope, so the chain is one link shorter and just as stable. */}
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- stable keep-alive content inset: always-present full-bleed layer whose CSS the active placement's Chrome pushes via insetStyle (titlebar inset); its parent-chain identity must not change, so no wrapping primitive
        className={cn(
          "absolute inset-0 min-h-0 min-w-0 transform-gpu",
          // A window is a box inside the surface, not its top-right corner:
          // the app's headers must not reserve or anchor the floating action
          // bar (its own titlebar does, when it reaches the corner).
          def?.frame === "window" && "floating-bar-boundary",
        )}
        style={insetStyle ?? undefined}
      >
        <TabSurface tab={tab} />
      </div>

      {/* Each mounted mode's optional sibling Chrome overlay (never a parent of
          TabSurface); only the active mode's is shown. Hiding one tears its
          effects down, so its cleanup clears any pushed style and the container
          falls back to defaults — showing it again re-pushes them. */}
      {mounted.map(
        (d) =>
          d.Chrome && (
            <ModeActivity key={d.id} active={d === def}>
              <PlacementStyleProvider value={styleApi}>
                <d.Chrome
                  tabId={tab.tabId}
                  appId={tab.appId}
                  title={title}
                  focused={focused}
                  exiting={exiting}
                  onClose={onClose}
                  onExit={onExit}
                  enteredFrom={enteredFrom}
                />
              </PlacementStyleProvider>
            </ModeActivity>
          ),
      )}
    </Theme>
  );
}
