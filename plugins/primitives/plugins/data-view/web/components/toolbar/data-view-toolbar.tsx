import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { type KeyboardEvent, type ReactNode, useCallback, useRef } from "react";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { spaceLength } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import {
  DATA_VIEW_HEADER_OFFSET_VAR,
  type CreateOption,
  type DataViewDensity,
  type DataViewSearchSuggestions,
  type ToolbarArrangement,
  type ToolbarParts,
} from "../../../core";
import { useToolbarControls } from "./use-toolbar-controls";
import { CompactControls } from "./compact-controls";
import { ControlTrigger } from "./control-trigger";
import { CreatorsControl } from "../creators-control";
import { barArrangement } from "./bar-arrangement";
import { SearchWithSuggestions } from "./search-suggestions";
import { PillsRow, ToolbarPill } from "./pills-toolbar";

/**
 * Below this container width the toolbar folds: search AND every control
 * collapse behind one `MdTune` options popover, leaving a single bar of
 * [switcher | actions | create | options]. Sized so the wide layout (search + 3
 * icon controls + view switcher) only ever renders when it genuinely fits —
 * narrow sidebars and split panes get the compact form automatically, with no
 * per-consumer flag.
 *
 * This is the *involuntary* half of the fold. The voluntary half is the
 * surface's own `density` (see below): the two are OR-ed, because a surface that
 * asked for compact chrome does not stop wanting it once it is wide, and a
 * surface that never asked still cannot render the wide row in 200px.
 */
const COMPACT_BREAKPOINT = 360;

/**
 * Below this container width the wide row keeps its shape but its search
 * field narrows: the views pill is the cell that yields, and without this a
 * fixed-width search squeezes it down to a sliver of the active view's name.
 */
const NARROW_SEARCH_BREAKPOINT = 720;

export interface DataViewToolbarProps {
  /**
   * Attached to the sticky toolbar element so the host can measure its height and
   * publish it as `--dv-header-offset` (grouped views stack their sticky group
   * headers below it).
   */
  stickyRef?: (node: HTMLElement | null) => void;
  title?: ReactNode;
  query: string;
  onQueryChange: (next: string) => void;
  /** Consumer-supplied arbitrary toolbar actions. */
  actions?: ReactNode;
  /**
   * The consumer's create affordances. The toolbar owns the `CreatorsControl`
   * element (built once below) because it is the only component that knows
   * `compact` — a single creator folds to an icon `+` button when narrow.
   */
  creators?: CreateOption[];
  /** The view switcher, in both forms (strip / collapsed chip). */
  switcher: ToolbarParts["switcher"];
  /** Number of view instances — the switcher is hidden when compact unless >1. */
  switcherCount: number;
  /**
   * The surface's declared density. `"compact"` folds the toolbar whatever it
   * measures; `"comfortable"` (the default) leaves the decision to the
   * measurement alone.
   */
  density?: DataViewDensity;
  /** The wide layout; absent → {@link barArrangement}, today's inline bar. */
  arrangement?: ToolbarArrangement;
  /** The search field's placeholder; default `"Search…"`. */
  searchPlaceholder?: string;
  /** The panel under the search field (`DataViewSearch.suggestions`). */
  searchSuggestions?: DataViewSearchSuggestions;
  /** Beside the search field (`DataViewSearch.trailing`). */
  searchTrailing?: ReactNode;
  /** Enter in the search field (`DataViewSearch.onSubmit`). */
  onSearchSubmit?: (query: string, opts: { mod: boolean }) => void;
  /** `ToolbarParts.asideInset`: how far the surface's aside reaches from the
   *  left edge, as a CSS length; default `"0px"` (no aside, or one in its own
   *  column beside the band). */
  asideInset?: string;
}

/**
 * The DataView toolbar — a `<Sticky>` header that adapts to the room it has AND
 * to the room the surface says it is willing to give. Wide and comfortable: the
 * full inline row. Compact — because the surface declared `density="compact"`,
 * or because the toolbar measured itself below {@link COMPACT_BREAKPOINT} — the
 * folded form, which is always exactly ONE bar. The measurement stays in place
 * either way: density only removes the *need* for room, it never asserts there
 * is any, so a compact-by-declaration surface and a compact-by-width one render
 * the same bar. The measurement switch happens before paint, so there is no
 * wide→compact flash.
 *
 * **It names no control.** It used to take `filterControl` / `sortControl` /
 * `fieldsControl` as three ReactNode props built by the host — the
 * collection-consumer rule broken literally, and the reason no plugin could add a
 * toolbar control. Now it reads `DataViewSlots.Control`, drops the ones that do
 * not apply to the active view + schema, orders them, and builds one identical
 * trigger per control.
 */
export function DataViewToolbar({
  stickyRef,
  title,
  query,
  onQueryChange,
  actions,
  creators,
  switcher,
  switcherCount,
  density,
  arrangement = barArrangement,
  searchPlaceholder = "Search…",
  searchSuggestions,
  searchTrailing,
  onSearchSubmit,
  asideInset = "0px",
}: DataViewToolbarProps): ReactNode {
  const [measureRef, { width }] = useElementSize();
  // The band is both the shell's measured sticky element and this toolbar's
  // own width probe — one element, two refs — so the arrangement's layout box
  // is its own and the measurement never depends on what an arrangement renders.
  const bandRef = useCallback(
    (node: HTMLElement | null) => {
      measureRef(node);
      stickyRef?.(node);
    },
    [measureRef, stickyRef],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const compact =
    density === "compact" || (width > 0 && width < COMPACT_BREAKPOINT);
  // Applicability, ordering and the badge count, derived the one way the
  // hosted trigger derives them too. A non-empty query counts toward the
  // compact trigger's badge, since the fold hides the search field.
  const { controls, activeCount: controlsCount } = useToolbarControls();
  const activeCount = controlsCount + (query.length > 0 ? 1 : 0);

  // Built once and relocated into whichever branch renders — the toolbar's
  // "each control element is built once" discipline. The compact fold has forms
  // of its own; the wide layout builds each part in the arrangement's forms.
  const { forms, component: Arrangement, spaceBelow, overlay } = arrangement;
  // An overlay arrangement floats the band in BOTH layouts, so the view's inset
  // (the band's measured height) means one thing whatever the width; the
  // compact fold then wears a card of its own (below) rather than floating as
  // a transparent row over the view.
  const floating = overlay === true;
  const fade = !compact && !floating;
  // `null` when the surface declares none, so an arrangement can tell (and
  // drop the divider it would draw before it).
  const creatorsControl =
    creators === undefined || creators.length === 0 ? null : (
      <CreatorsControl
        creators={creators}
        compact={compact}
        form={forms.creators}
      />
    );
  const field = (
    <SearchInput
      ref={searchRef}
      value={query}
      onChange={(e) => onQueryChange(e.target.value)}
      {...(onSearchSubmit === undefined
        ? {}
        : {
            onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              onSearchSubmit(query, { mod: e.metaKey || e.ctrlKey });
            },
          })}
      placeholder={searchPlaceholder}
      appearance={compact ? "field" : forms.search}
      // Wide field: a fixed lane in the inline row — wider when it searches
      // beyond the rows (suggestions). Compact: full width of the options
      // popover (the wrapper's own block box) — hence no width class there.
      // Bare: fills whatever cell the arrangement gives it.
      wrapperClassName={
        !compact && forms.search !== "bare"
          ? cn(
              searchSuggestions !== undefined
                ? "w-80"
                : width > 0 && width < NARROW_SEARCH_BREAKPOINT
                  ? "w-32"
                  : "w-48",
            )
          : undefined
      }
    />
  );
  const fieldWithTrailing =
    searchTrailing === undefined ? (
      field
    ) : (
      <Line className="gap-xs">
        <Fill>{field}</Fill>
        {searchTrailing}
      </Line>
    );
  const searchInput =
    searchSuggestions === undefined ? (
      fieldWithTrailing
    ) : (
      <SearchWithSuggestions
        input={fieldWithTrailing}
        inputRef={searchRef}
        suggestions={searchSuggestions}
      />
    );

  const titleNode = title ? (
    <Text as="div" variant="label">
      {title}
    </Text>
  ) : null;

  // The compact fold keeps the two-pill look: the views pill (only when there
  // is more than one view to switch between) and a tools pill holding the
  // actions, the creators and the one options trigger — search and every
  // control folded behind it (a non-empty query counts toward its badge, so
  // a folded-away search is still visible from the closed bar). ONE line,
  // never wrapping: the views pill is the cell that scrolls sideways.
  const hasActions =
    actions !== undefined && actions !== null && actions !== false;
  const toolsAtRest = hasActions || creatorsControl !== null;
  const compactRow = (
    <PillsRow
      overlay={floating}
      {...(floating
        ? {
            className: "p-sm",
            style: {
              paddingLeft: `calc(${asideInset} + ${spaceLength("sm")})`,
            },
          }
        : {})}
      lead={titleNode}
      views={switcherCount > 1 ? switcher.strip : null}
      tools={
        toolsAtRest ? (
          <>
            {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
            {actions}
            {creatorsControl}
            <CompactControls
              search={searchInput}
              controls={controls}
              activeCount={activeCount}
              searching={query.length > 0}
            />
          </>
        ) : null
      }
      // A tools pill holding nothing but the hover-revealed trigger would be
      // an empty pill at rest — so there the PILL is what reveals.
      trailing={
        toolsAtRest ? null : (
          <CompactControls
            search={searchInput}
            controls={controls}
            activeCount={activeCount}
            searching={query.length > 0}
            frame={(node, revealClass) => (
              <ToolbarPill
                overlay={floating}
                label="Tools"
                className={revealClass}
              >
                {node}
              </ToolbarPill>
            )}
          />
        )
      }
    />
  );

  const bandContent = !compact ? (
    <Arrangement
      title={titleNode}
      switcher={switcher}
      search={searchInput}
      focusSearch={focusSearch}
      query={query}
      controls={controls.map((c) => (
        <ControlTrigger key={c.id} control={c} form={forms.controls} />
      ))}
      foldedControls={
        <CompactControls
          controls={controls}
          activeCount={controlsCount}
          searching={false}
          revealOnHover={false}
          form={forms.controls}
        />
      }
      actions={actions}
      creators={creatorsControl}
      asideInset={asideInset}
    />
  ) : (
    compactRow
  );

  return (
    // `nav` (not the default `raised`) so the toolbar out-stacks the grouped
    // views' own sticky group headers (`raised`): an outgoing group header slides
    // UNDER the toolbar instead of painting over it during the sticky hand-off.
    //
    // `hoverRevealGroup` anchors the compact options trigger's reveal on the
    // TOOLBAR BAND, not on the DataView root: the trigger belongs to the bar, so
    // the bar is what you point at to get it back. Anchored on the root, grazing
    // any row — while reading the list, or on the way somewhere else entirely —
    // flickered a control in the far top corner, unconnected to anything the
    // user was doing. It rides the `<Sticky>` rather than the bar `<div>` inside
    // it (same box, one element out), so the pill row inside owns its own box.
    // Pure CSS (`group-hover`), so hovering costs zero re-renders; the state
    // hook would re-render every windowed row on each pointer enter/leave.
    <>
      {floating ? (
        // Floating: the band spans the surface's top edge over the view —
        // transparent (no mask: the view shows between the cards) and
        // click-through (`decorative`), each card opting back in. It never
        // scrolls: it is a child of the surface root, not of the view's
        // scroller.
        <Pin
          to="top"
          stretch
          decorative
          layer="nav"
          ref={bandRef}
          className={hoverRevealGroup}
        >
          {bandContent}
        </Pin>
      ) : (
        <Sticky
          edge="top"
          mask
          layer="nav"
          ref={bandRef}
          className={hoverRevealGroup}
        >
          {bandContent}
        </Sticky>
      )}
      {/* The wide band's fade: content scrolls UNDER the band and dissolves
        into it. Its own zero-height `<Sticky mask="fade">` pinned at the
        band's bottom (the measured header offset), NOT the band's own
        `mask="fade"`: the band is `nav`, so its tail would paint over the
        group headers pinned right under it, washing their labels out. This
        tail is `raised` and comes BEFORE the views in the DOM, so a pinned
        group header (also `raised`, later) covers it, while rows (no layer)
        pass under it. The compact fold keeps the plain opaque band: its
        tight rhythm has no runway for a tail (below). */}
      {fade ? (
        <Sticky
          edge="top"
          mask="fade"
          layer="raised"
          aria-hidden
          style={{ top: `var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)` }}
        />
      ) : null}
      {/* The arrangement's space below the band (for the default bar, the
        fade's runway: at rest the first row starts where the tail has
        faded out). A sibling of the `<Sticky>`, not padding inside it, so it
        scrolls away with the content instead of growing the pinned band (and
        the measured header offset). */}
      {!compact && !floating && spaceBelow ? (
        <div aria-hidden style={{ height: spaceBelow }} />
      ) : null}
    </>
  );
}
