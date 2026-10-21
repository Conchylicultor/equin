import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { useContext, useMemo, type ReactNode } from "react";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { SlotItemLayout } from "@plugins/primitives/plugins/slot-render/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import { PaneScroll } from "./pane-scroll";
import { FloatingHeaderScroll } from "./floating-header-scroll";
import { PaneIconAction } from "./pane-icon-action";
import { PaneHeaderCell, type PaneHeaderItem } from "./pane-header-item";
import { PaneTitleContext, type PaneTitleValue } from "./pane-title";
import { InsidePaneTitleContext } from "./pane-title-guard";
import { usePaneEntry, type AnyPane } from "../pane";
import { PaneLayoutContext } from "../maximize-context";
import { SurfaceChromeContext } from "../surface-chrome-context";
import { useReservesFloatingBar } from "../reserves-floating-bar";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");
const arrowBackIcon = symbol("arrow-back");

/**
 * How the header is drawn. `"bar"` (the default) is the full-width header row
 * above the body (or, with `floatingHeader`, pinned over the top of it).
 * `"card"` draws the SAME row — the same slot, title, leading control, Back,
 * promote and close — as a content-sized floating card (the `float` surface)
 * over the body's top-left corner, and gives the body the pane's whole height:
 * for a canvas that runs edge to edge under its chrome (the prototype viewer).
 * A card has no width to run out of, so it has no `⋯`: its title is the one
 * cell that gives, ellipsizing once the card reaches the pane's width.
 */
type HeaderPresentation =
  | {
      header?: "bar";
      /**
       * Float the header over the TOP of the body instead of above it: the bar is
       * the first thing in the pane's one scroll, pinned to its top edge,
       * see-through with no rule while the body sits at its top, and masking what
       * scrolls under it — rule drawn — once anything does.
       *
       * For a page whose opening band is designed to run up behind its header (the
       * website hero's glow), which a header above the scroll can never show. At
       * rest the bar still takes its height in flow, so nothing moves until the
       * body scrolls. Default false.
       */
      floatingHeader?: boolean;
      /**
       * With `floatingHeader`: the theme scope the header wears — for a page whose
       * own picture runs under the header in another palette than the page (the
       * website's iceberg: a white sky, then black water), so the header's ink
       * reads on it. The page may change it as it scrolls. The bar masks with that
       * theme's background. A scope name, as `<Theme name>` takes it
       * (`subThemeScope(…)`).
       */
      headerTheme?: string;
      /**
       * With `floatingHeader`: once content scrolls under it, frost the bar (its
       * background at 72%, the content blurred) instead of masking it opaque.
       * Default false.
       */
      headerGlass?: boolean;
    }
  | {
      header: "card";
      floatingHeader?: never;
      headerTheme?: never;
      headerGlass?: never;
    };

type PaneChromeProps = HeaderPresentation & {
  /**
   * The pane this chrome is for. Its header title comes from HERE — the
   * pane's `Pane.define({ title })` — and nowhere else: `PaneChrome` accepts no
   * header content at all. The title is PUBLISHED, not painted here: the pane's
   * own `title` header contribution reads it off {@link PaneTitleContext} and
   * renders it, so it is one item of the header's one slot — orderable and
   * hideable like every other.
   */
  pane: AnyPane;
  /**
   * Render ONLY the header's yielding cell — the pane title — and suppress
   * every contributed action occupant. For a host that renders those actions
   * itself somewhere else (inside its content area), while still wanting the
   * standard title + expand + close chrome.
   *
   * The rule, stated once: an item with `cell` set survives, an ordinary
   * occupant does not.
   */
  titleOnly?: boolean;
  /**
   * The pane's non-scrolling overlay layer — widgets that float over the BODY
   * (an outline rail) rather than scroll with it. Rendered as a SIBLING of the
   * single `PaneScroll`, inside a `relative isolate` host: an absolutely
   * positioned child of a scroller scrolls away with the document, and a host
   * wrapped around `PaneChrome` instead spans the header — so a corner-pinned
   * overlay lands on the header's own actions.
   *
   * The wrapper exists only when this is passed; omit it and the body is the
   * same tree it always was.
   */
  overlay?: ReactNode;
  children: ReactNode;
};

/**
 * The standard pane header: ONE overflow-collapsing bar rendering the pane's
 * one header slot, then an optional expand button and a × close button. The
 * close button is shown by default for panes with a parent (opt out via
 * `chrome: { close: false }`).
 *
 * There is no second kind of header. The title is a contribution of the same
 * slot (rendered in the bar's yielding cell), so a rich header — transport,
 * view-switcher, volume — is the ordinary case with more items in it, and it
 * collapses into the `⋯` like anything else. What separates a leading group
 * from a trailing one is a `spacer` node in the slot's reorder config, not a
 * field on the contribution.
 */
export function PaneChrome({
  pane,
  titleOnly,
  overlay,
  header: presentation = "bar",
  floatingHeader = false,
  headerTheme,
  headerGlass = false,
  children,
}: PaneChromeProps) {
  const chrome = pane._internal.chrome;
  const entry = usePaneEntry(pane._internal);
  const layoutCtx = useContext(PaneLayoutContext);
  const { contentOwnsTopChrome, leadingControl } =
    useContext(SurfaceChromeContext);
  const doClose = pane.useClose();
  const doBack = pane.useBack();
  const promote = pane.usePromote();
  const titleValue = useMemo<PaneTitleValue>(
    () => ({ pane: pane._internal, entry }),
    [pane, entry],
  );
  // Surface-edge chrome: only when this pane header IS the surface's top chrome.
  // The first top-row header hosts the leading control (sidebar toggle); the
  // last reserves the floating-action-bar safe area on its right.
  const showLeading =
    contentOwnsTopChrome && layoutCtx?.atSurfaceStart && leadingControl != null;
  const reserveEnd = useReservesFloatingBar();
  // Painted alone (full-pane), a child pane's way out is BACK to its parent —
  // leading, like a browser's — not a × closing a column beside it. And a
  // same-app promote has nothing on screen to detach from.
  const ancestorsHidden = layoutCtx?.ancestorsHidden === true;
  const showPromote =
    chrome.promote &&
    promote !== null &&
    (!ancestorsHidden || promote.kind === "cross-app");
  // `atTop` is only ever true for a floating header resting over the top of the
  // body — nothing below it to separate, so the rule goes.
  const header = (atTop: boolean) => (
    <Bar
      tier="pane"
      endSafeArea={reserveEnd}
      // The header row is a hover-reveal anchor: a header item may wear
      // `hoverRevealTargetInAnchor` to show only while the row is hovered.
      className={cn(
        hoverRevealGroup,
        layoutCtx?.dragHandleProps && "cursor-grab active:cursor-grabbing",
        floatingHeader && "transition-colors",
        atTop && "border-transparent",
      )}
      onDoubleClick={layoutCtx?.onDoubleClickHeader}
      {...layoutCtx?.dragHandleProps}
    >
      {showLeading && leadingControl}
      {ancestorsHidden && chrome.close && doBack && (
        <PaneIconAction label="Back" icon={arrowBackIcon} onClick={doBack} />
      )}
      {/* The bar IS the row's grow cell (`min-w-0 flex-1`), which is why
              there is no `Fill` beside it: a second claimant on the same slack
              breaks the one contract the primitive has. Which is also why
              `align` is the bar's own prop — nothing outside it can place
              occupants within slack it has taken entirely. With no `spacer`
              node in the slot's config, `"end"` packs the occupants right; the
              title's yielding cell holds the leftover in front of them, so a
              header with a title reads exactly as it always has and a header
              without one costs nothing. */}
      <AdaptiveBar gap="xs" label="More actions" align="end">
        <PaneTitleContext.Provider value={titleValue}>
          <pane.Actions.Render>
            {(item) => renderHeaderItem(item, titleOnly)}
          </pane.Actions.Render>
        </PaneTitleContext.Provider>
      </AdaptiveBar>
      {showPromote && promote && (
        <PaneIconAction
          label={
            promote.kind === "cross-app"
              ? `Open in ${promote.app.name}`
              : "Expand pane"
          }
          icon={navIcons.expand}
          {...linkProps(promote)}
        />
      )}
      {!ancestorsHidden && chrome.close && doClose && (
        <PaneIconAction label="Close" icon={closeIcon} onClick={doClose} />
      )}
    </Bar>
  );
  const content = <ContentScope>{children}</ContentScope>;
  if (presentation === "card") {
    return (
      // positioning host for the card and the overlay: the scroll's PARENT, so neither scrolls away with the body
      <div className="relative isolate h-full">
        <PaneScroll>{content}</PaneScroll>
        {overlay}
        <Pin
          to="top-left"
          offset="md"
          className="max-w-[calc(100%-2*var(--space-md))]"
        >
          <Surface level="float">
            {/* The card's row: the bar's own height and insets (density
                `chromePaneH`, `chromePanePad*`), the theme's toolbar ink, and
                no rule — the card's edge is its border. */}
            <Line
              className={cn(
                "h-chrome-pane gap-2xs px-chrome-pane text-toolbar-foreground",
                hoverRevealGroup,
              )}
              onDoubleClick={layoutCtx?.onDoubleClickHeader}
            >
              <ControlSizeProvider size="sm">
                {showLeading && leadingControl}
                {ancestorsHidden && chrome.close && doBack && (
                  <PaneIconAction
                    label="Back"
                    icon={arrowBackIcon}
                    onClick={doBack}
                  />
                )}
                <PaneTitleContext.Provider value={titleValue}>
                  {/* Each item is its own box (a hidden one leaves no gap). */}
                  <SlotItemLayout orientation="host-owned">
                    <pane.Actions.Render>
                      {(item) => renderCardItem(item, titleOnly)}
                    </pane.Actions.Render>
                  </SlotItemLayout>
                </PaneTitleContext.Provider>
                {showPromote && promote && (
                  <PaneIconAction
                    label={
                      promote.kind === "cross-app"
                        ? `Open in ${promote.app.name}`
                        : "Expand pane"
                    }
                    icon={navIcons.expand}
                    {...linkProps(promote)}
                  />
                )}
                {!ancestorsHidden && chrome.close && doClose && (
                  <PaneIconAction
                    label="Close"
                    icon={closeIcon}
                    onClick={doClose}
                  />
                )}
              </ControlSizeProvider>
            </Line>
          </Surface>
        </Pin>
      </div>
    );
  }
  const scroll = floatingHeader ? (
    <FloatingHeaderScroll
      header={header}
      theme={headerTheme}
      glass={headerGlass}
    >
      {content}
    </FloatingHeaderScroll>
  ) : (
    <PaneScroll>{content}</PaneScroll>
  );
  return (
    <Column
      className="h-full"
      header={floatingHeader ? undefined : header(false)}
      // The pane body owns exactly one scroll, expressed via the shared
      // `PaneScroll` scaffold (`<Scroll axis="y" fill h-full>`) instead of
      // Column's managed `Scroll` body — identical scrolling, one sanctioned
      // idiom. `scrollBody={false}` so Column doesn't add a second scroll.
      scrollBody={false}
      body={
        overlay == null ? (
          scroll
        ) : (
          // positioning host for the pane's overlay layer: it must be the scroller's PARENT (an absolute child of a scroller scrolls away) and sit below the header
          <div className="relative isolate h-full">
            {scroll}
            {overlay}
          </div>
        )
      }
    />
  );
}

/**
 * One header contribution as a child of a `card` header's row. No fit ledger
 * and no `⋯`: an ordinary item is itself, and the yielding cell (the title) is
 * the one box that gives, so the card ellipsizes its title at the pane's width.
 */
function renderCardItem(
  item: PaneHeaderItem & { id: string },
  titleOnly?: boolean,
): ReactNode {
  if (item.cell === "yield") {
    return (
      <div className={yieldClass("x")}>
        <InsidePaneTitleContext.Provider value={true}>
          <PaneHeaderCell {...item} />
        </InsidePaneTitleContext.Provider>
      </div>
    );
  }
  if (titleOnly) return null;
  return <PaneHeaderCell {...item} />;
}

/**
 * One header contribution as a bar child — the ONE place `cell` is read.
 *
 * An ordinary item is an occupant: measured, laddered, and relocated behind the
 * `⋯` when the row runs out of room. A `cell: "yield"` item is the row's give
 * instead — excluded from the fit ledger, `min-w-0` so its text ellipsizes, and
 * `grow` so it holds the row's leftover in front of the trailing occupants.
 * That is the pane title's shape, and stating it as a public field rather than
 * as "the title" is what keeps the title an item like any other.
 */
function renderHeaderItem(
  item: PaneHeaderItem & { id: string },
  titleOnly?: boolean,
): ReactNode {
  if (item.cell === "yield") {
    return (
      <AdaptiveBar.Yield grow>
        {/* Marks everything the title cell renders — and ONLY that: the
            item's own slot wrapping sits outside this — so a render slot
            mounted inside the title throws (`pane-title-guard.tsx`). */}
        <InsidePaneTitleContext.Provider value={true}>
          <PaneHeaderCell {...item} />
        </InsidePaneTitleContext.Provider>
      </AdaptiveBar.Yield>
    );
  }
  if (titleOnly) return null;
  return (
    <AdaptiveBar.Item id={item.id}>
      <PaneHeaderCell {...item} />
    </AdaptiveBar.Item>
  );
}
