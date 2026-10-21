import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  assign,
  barRung,
  clearAbsentRungs,
  describeEvidence,
  dropItem,
  emptyBlockedRungs,
  emptyWidthCache,
  estimate,
  inlineWidthsFor,
  isAbsentRung,
  isShifted,
  markAbsentRung,
  noAbsentRungs,
  offeredRungCount,
  overflowPx,
  passBudget,
  premiseShift,
  pushRound,
  recordMoves,
  staleOthers,
  summarizeRounds,
  sweepBarred,
  unbarItem,
  write,
  type AbsentRungs,
  type BlockedRungs,
  type FitItem,
  type MovedWidth,
  type Round,
  type RoundItem,
  type Span,
  type WidthCache,
} from "@plugins/primitives/plugins/adaptive-bar/core";
import {
  formatLineageNode,
  formatLineagePath,
} from "@plugins/primitives/plugins/ui-context/core";
import { collectLineage } from "@plugins/primitives/plugins/ui-context/web";
import type {
  ActionForm,
  ShrinkLadder,
} from "@plugins/primitives/plugins/action-presentation/web";
import {
  cn,
  SingleLineProvider,
  useRegionForwardedAttrs,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { type SpaceStep } from "@plugins/primitives/plugins/css/plugins/space-ramp/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useRequestGrow } from "@plugins/primitives/plugins/css/plugins/grow-relay/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { SlotItemLayout } from "@plugins/primitives/plugins/slot-render/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEditMode } from "@plugins/primitives/plugins/edit-mode-signal/web";
import { AdaptiveBarItem } from "./bar-item";
import {
  failLoudly,
  reportFault,
  HARD_ROUND_CEILING,
  HYSTERESIS_PX,
  MAX_PREMISE_SHIFTS,
  MAX_SLACK_PROBES,
  MAX_SURRENDERS,
  MAX_ZERO_RECOVERIES,
  TRACE_ROUNDS,
  WIDTH_EPSILON_PX,
} from "./diagnostics";
import { DEFAULT_LADDER, formFor, inlineRungsOf, yieldRankOf } from "./ladder";
import { readRowMetrics, useLayoutMeasured, useMeasureBundle } from "./measure";
import { OverflowPanel } from "./overflow-panel";
import {
  BarFormsContext,
  BarRegionAttrsContext,
  BarRegistryContext,
  type BarItemEntry,
  type BarRegistry,
} from "./registry";
import {
  dockGroup,
  dockInline,
  holdsIframe,
  isDockedInline,
  supportsStatePreservingMove,
} from "./relocate";
import { AdaptiveBarYield, yieldFloorPx } from "./bar-yield";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { rendersNothing } from "./presence";

const moreHorizIcon = symbol("more-horiz");

/** What happens to an occupant the row cannot fit. */
export type AdaptiveBarOverflow =
  /** Relocate it into the always-mounted panel behind a `⋯` trigger. */
  | "panel"
  /** Keep everything in the row and let the row scroll horizontally. */
  | "scroll"
  /** Drop it. Only legitimate when the host has a SECOND route to the content. */
  | "clip";

/** Which end of its own slack the row's occupants sit against. */
export type AdaptiveBarAlign = "start" | "end";

interface AdaptiveBarBaseProps {
  /** Gap between occupants, from the closed density ramp. Default `"xs"`. */
  gap?: SpaceStep;
  /** Accessible name of the `⋯` trigger and its panel. Default `"More"`. */
  label?: string;
  /**
   * Where the occupants sit inside the bar. Default `"start"`; `"end"` packs
   * them against the far edge — a trailing action cluster with the row's slack
   * in front of it, which is what a pane/toolbar header wants.
   *
   * A prop rather than a `className`, because the bar taking ALL the slack is
   * its one contract: a consumer cannot answer "where in the slack" with a
   * competing `Fill` sibling, so the bar has to answer it.
   */
  align?: AdaptiveBarAlign;
  /**
   * The occupants may paint OUTSIDE this bar's box, so the bar stops clipping
   * (`overflow-visible` in place of {@link BAR_CLIP}). For a row holding
   * something that legitimately reveals itself beyond the strip — a pane
   * header whose title is a `CollapsibleWrap` expanding downward over the
   * content below.
   *
   * It changes nothing about the fit: the clip was never the mechanism, only
   * the backstop for a row with no room left, and an over-full row already
   * reports its own fault. What it does change is what that backstop looks
   * like — an over-full `spill` row paints past its edge instead of hiding the
   * excess — which is the trade a host makes deliberately by passing this.
   *
   * A prop and not a `className`, for the same reason as {@link align}: the
   * overflow is one of the mechanics this primitive owns, so reaching in with a
   * raw `overflow-*` would fight it rather than ask it. Both axes go visible
   * together because CSS gives no choice — `visible` on one axis with `hidden`
   * on the other computes to `auto`, i.e. a scroll container, which is neither
   * of the two things a caller could mean.
   *
   * Two of this primitive's own docs below assume the clip, and under `spill`
   * they read differently: the `no-slack` ceiling ("everything inline, CSS
   * clips") no longer has the clip to bound a row whose width it has stopped
   * trusting, and the over-full 0px report's "every occupant AND the `⋯` are
   * clipped to invisibility" becomes "painted outside the row" instead. Both
   * are still reported; only what they look like changes.
   */
  spill?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * `spill` and `overflow: "scroll"` are the SAME question answered twice — a row
 * cannot both scroll its own excess and let that excess paint outside it
 * (`BAR_SCROLL` is `overflow-x-auto`, and one axis being non-`visible` is
 * exactly what makes the other compute to `auto`). So the two are not
 * combinable rather than merely discouraged: a `scroll` bar has no `spill` to
 * pass.
 */
export type AdaptiveBarProps = AdaptiveBarBaseProps &
  (
    | {
        /** Default `"panel"`. */
        overflow?: "panel" | "clip";
        spill?: boolean;
      }
    | { overflow: "scroll"; spill?: never }
  );

/**
 * The bar DEFINES itself as the grow cell of its row, and that is a contract,
 * not a style choice: `barRoot.getBoundingClientRect().width` is the width the
 * bar was GIVEN, read with no ancestor-walking, no mutate-reflow-restore, and no
 * forced recalculation per sibling. (The fit's budget is that minus the root's
 * own padding and border — `readRowMetrics`'s `insetPx` — because the occupants
 * are laid out in the content box and `measureRowOverflow` judges them against
 * that same box, and minus whatever a yielding child reserved as its floor
 * (`yieldFloorPx`), which is room the occupants may not have. Do not "simplify"
 * either subtraction away: the first is the difference
 * between a budget and a budget for room that does not exist, and a consumer
 * `className` carrying padding is all it takes; the second is the difference
 * between a row that relocates an occupant and one that eats its own title.
 * Pinned in
 * `web/__tests__/row-inset.test.tsx`.) A primitive that took a content-sized container
 * would have to go looking for the width; this one is handed it by the layout
 * engine.
 *
 * Kept as a module const rather than an inline literal: the `no-adhoc-*` rules
 * harvest string literals reached from a `className` — so, exactly like
 * `viewport-overlay`'s `OVERLAY_ROOT`, the primitive that OWNS these mechanics
 * does not have to disable the rule that keeps them out of feature code.
 *
 * Rigidity — {@link rigidClass}, `shrink-0` — is the other half of that
 * contract, and it is what makes the width ledger's axiom true rather than
 * merely assumed: **this row never takes width from what it holds.** See
 * `core/width-cache.ts`. An ordinary flex item (`flex: 0 1 auto`) is squeezed
 * whenever its row is over-full — which is exactly the state a pass measures in,
 * since it measures the placement React has already committed. Two things then
 * go wrong at once: the ledger stores a placement-dependent number as `exact`,
 * and `measureRowOverflow` goes blind, because flex absorbs the whole deficit
 * and the occupants sum to exactly the content box.
 *
 * Whether an occupant can be squeezed at all is an accident of its content — a
 * container's floor is its own min-content, and under this row's
 * `whitespace-nowrap` a text run's min-content IS its natural width, which is
 * why every occupant shipping today happens to be safe and a widget with
 * reflowable content would not be.
 *
 * **It is declared by each rigid thing, not by the row**, and that is not a
 * preference: it used to be `[&>*]:shrink-0` here, and a parent selector reaches
 * DIRECT children only. An occupant's container is docked at its own anchor, and
 * the anchor is wherever the host put it — through `.Render` that is two or
 * three `display: contents` wrappers down, still a flex item of this row and no
 * longer a child of it. So the row-level selector silently stopped reaching the
 * containers, and a squeezable occupant is the proven blind-the-guard failure
 * (`exhibits/` → `adaptive-bar/squeezable-occupants`, 186px → 83px). The two
 * things that ARE direct children and must stay rigid say so themselves: the `⋯`
 * trigger (whose width `measureTrigger` caches, so one squeezed reading would
 * under-reserve it forever) and, by construction, every minted container
 * (`bar-item.tsx`).
 *
 * What the row therefore no longer declares for its non-occupant children is
 * deliberate rather than lost: a reorder `spacer` is `flex: 1 1 0%`, so with a
 * base size of 0 and no content there is nothing for a shrink to take, and
 * {@link AdaptiveBarYield} wants the opposite of rigid — it is the one child
 * allowed below its own content width, down to the floor it reserves out of the
 * budget so that it is not the one child paying for all the others.
 */
const BAR_ROOT = "min-w-0 flex-1 whitespace-nowrap";
/** `panel`/`clip`: what does not fit leaves the row, and the row never spills. */
const BAR_CLIP = "overflow-hidden";
/** `scroll`: nothing leaves the row; the row itself scrolls. */
const BAR_SCROLL = "overflow-x-auto";
/** `spill`: an occupant legitimately paints outside the row (see the prop). */
const BAR_SPILL = "overflow-visible";
/**
 * The collapsed bucket is the OPPOSITE of a grow cell: it is one `⋯` sitting
 * among the row's other occupants, so taking the slack would starve the very
 * items it sits beside. It also measures nothing, so it has no use for the width
 * it would be taking.
 */
const BAR_COLLAPSED_ROOT = "shrink-0";
/** `align="end"`: the occupants pack against the far edge of the bar's slack. */
const BAR_ALIGN_END = "justify-end";

/**
 * A bar whose occupants shrink and relocate instead of being transformed or
 * dropped.
 *
 * ```tsx
 * <AdaptiveBar gap="xs" label="More actions">
 *   <SomeSlot.Render>
 *     {(item) => <AdaptiveBar.Item id={item.id}><Item {...item} /></AdaptiveBar.Item>}
 *   </SomeSlot.Render>
 * </AdaptiveBar>
 * ```
 *
 * The host names no contributor, declares no priority, hardcodes no width, and
 * renders no second copy of anything. Every policy comes from the widgets
 * themselves through `useActionForm`, because a bar's occupants come from
 * different plugins and it can name none of them.
 */
export function AdaptiveBar(props: AdaptiveBarProps): ReactElement {
  const {
    gap = "xs",
    label = "More",
    overflow = "panel",
    align = "start",
    spill = false,
    children,
    className,
  } = props;
  return (
    <AdaptiveBarShell
      gap={gap}
      label={label}
      overflow={overflow}
      align={align}
      spill={spill}
      className={className}
      collapsed={false}
    >
      {children}
    </AdaptiveBarShell>
  );
}

export interface AdaptiveBarCollapsedProps {
  /** Accessible name of the trigger and its panel. */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * The authored bucket: every occupant relocates, unconditionally, and nothing
 * is ever measured.
 *
 * For a slot whose layout config says "these live behind a `⋯`" — membership is
 * a decision the author already made, so width has no say in it. It is the same
 * item hosts and the same always-mounted panel as {@link AdaptiveBar}, minus the
 * fit math, which is why a rich widget parked here is still the same live
 * instance rather than a re-rendered menu row.
 */
export function AdaptiveBarCollapsed({
  label,
  children,
  className,
}: AdaptiveBarCollapsedProps): ReactElement {
  return (
    <AdaptiveBarShell
      gap="xs"
      label={label}
      overflow="panel"
      // The collapsed bucket is one `⋯` sitting among its row's other
      // occupants, so it holds no slack to align anything against.
      align="start"
      spill={false}
      className={className}
      collapsed
    >
      {children}
    </AdaptiveBarShell>
  );
}

AdaptiveBar.Item = AdaptiveBarItem;
AdaptiveBar.Collapsed = AdaptiveBarCollapsed;
AdaptiveBar.Yield = AdaptiveBarYield;

/**
 * Which half of the chain a width fault should send the reader to.
 *
 * The ask travels through the boxes this primitive knows (the slot cell, the
 * reorder edit-mode wrapper) and is invisible to the ones it does not (a
 * hand-rolled wrapper `<div>`), so the count separates "nobody above me can
 * give room" from "everyone I can see gave it and something I cannot see took
 * it back".
 *
 * Module-level and called at the fault site, not derived in render: a fresh
 * string per render would churn `reconcile`, whose identity the resize
 * observer's layout effect keys on.
 */
function relayNote(relays: number): string {
  if (relays === 0) {
    return "No box above this bar relayed its grow request. Either it is not inside a slot cell at all — its row is simply not giving it room — or the nearest box above it is a Line/Row/Bar, which stops the ask because it IS the row; then the fix is that row, not the bar.";
  }
  return `${String(relays)} box(es) above this bar relayed its grow request and every one of them applied it, so whatever swallows the grow is a box this primitive cannot see — a hand-rolled wrapper between the relay and the bar. Recompose it onto Fill / Line.`;
}

/** id → rung index, or `null` for "left the row". */
type Placement = ReadonlyMap<string, number | null>;

/**
 * The three refs that together mean "this bar has stopped deciding": whether it
 * has, the width it stopped at, and how many times it has done so.
 *
 * Bundled so {@link commitFloor} takes all of them or none. Flooring and
 * stopping are one act — a caller able to do half of it is the render loop that
 * killed the Layout Lab pane.
 *
 * Distinct from `degraded`, and the two must not be merged. `degraded` answers
 * "my width reading is a lie", so its remedy is the CEILING and it latches for
 * good. This one answers "my width is fine and my own search disagrees with the
 * engine at this width", so its remedy is the floor and it re-arms on a resize.
 */
interface Surrender {
  surrendered: { current: boolean };
  at: { current: number | null };
  count: { current: number };
}

/**
 * One search: everything scoped to "this row, this question, until the answer
 * stops moving".
 *
 * Bundled for the same reason {@link Surrender} is — a caller able to reset half
 * of it would file a fault describing a different episode, or reset the counter
 * that is the termination guarantee. {@link startEpisode} takes all of it or
 * none.
 *
 * The two counters are deliberately different, and merging them would give back
 * one of the two bugs this exists to fix:
 *
 * - `rounds` is **rounds of the same question**. A round that follows a resize,
 *   a contribution mounting or an occupant resizing itself is a new question,
 *   and answering it differently is not evidence that the search fails to
 *   settle. It resets whenever the premise moves. That is the fix.
 * - `total` is **rounds since the last settled answer**, and NOTHING resets it
 *   short of settling. It is the termination guarantee: `reconcile` re-enters
 *   itself synchronously after every commit, so an occupant that resizes itself
 *   on each of those commits would reset `rounds` forever and take the pane down
 *   with React's nested-update limit. See {@link HARD_ROUND_CEILING}.
 */
interface Episode {
  rounds: number;
  total: number;
  /** How many times the premise moved without the search ever settling. */
  shifts: number;
  /** What the previous round decided from. */
  premise: Round | null;
  /** The last few rounds, kept for whatever fault ends the episode. */
  trace: Round[];
  /** Occupants that moved under the search, collapsed per (id, rung). */
  moved: Map<string, MovedWidth>;
  /**
   * The best answer the search actually produced: the widest placement it
   * blessed as fitting, from measurements rather than estimates, at the width
   * recorded beside it.
   *
   * A search that runs out of rounds has usually produced perfectly good
   * answers along the way. Throwing all of them away and taking the floor is
   * what makes a transient fault cost the user their whole toolbar.
   */
  best: { placement: Placement; available: number } | null;
  /*
   * Every width an episode records — this one, and `promoted`'s `atWidth` — is
   * the SEARCH's budget: the row's content box minus whatever the yielding cell
   * reserved (`budget` in `reconcile`). Both are compared against a later pass's
   * budget, so the currency is consistent; recording the row's own width instead
   * would make the pair disagree exactly when a title appears or goes away.
   */
  /**
   * Rungs the last committed pass promoted INTO, and the width it decided at —
   * H2's evidence.
   *
   * Episode state rather than a free ref, because it is scoped to exactly what
   * the counters and the premise are: this row, this question. A promotion is
   * evidence only against the width, the item set and the widths it was decided
   * at, and {@link Episode} is where "a caller able to reset half of it" has no
   * spelling. In its own ref it survived every early return in `reconcile` — a
   * collapsed pane, a surrendered bar, a zero-width row — and the next pass then
   * barred a rung at a width that had never rejected anything.
   *
   * It carries its own width for the same reason. Where the premise held, the
   * recorded width and the current pass's budget are the same number by
   * construction; where a future early return is added they are not, and this is
   * the spelling in which the wrong one cannot be named.
   */
  promoted: Map<string, { rung: number; atWidth: number }>;
}

function newEpisode(): Episode {
  return {
    rounds: 0,
    total: 0,
    shifts: 0,
    premise: null,
    trace: [],
    moved: new Map(),
    best: null,
    promoted: new Map(),
  };
}

const EMPTY_PLACEMENT: Placement = new Map();

/**
 * Where an occupant currently sits.
 *
 * Three states, and the first two must never be read as each other:
 *
 * - a stored **number** — the rung the last decision put it at;
 * - a stored **`null`** — the fit deliberately took it out of the row. Reaching
 *   for `?? 0` collapses this into the case below (`null ?? 0` is `0`), which
 *   silently puts every evicted occupant straight back in the row and makes the
 *   bar look as though it simply never overflows;
 * - **no entry at all** — the last decision did not place it. Either it mounted
 *   since, or it renders nothing at every form it was offered, so `assign` had
 *   nothing to place. Both want rung 0, and for the same reason: nothing has
 *   been decided about this occupant, so it renders as itself and its own
 *   output decides what happens next.
 *
 * That last default is safe only because an occupant that renders nothing at
 * rung 0 keeps rendering nothing there — the bar records what a widget renders
 * per RUNG and never offers one it vanishes on (`core/absent-rungs.ts`). Before
 * it did, this default was the other half of a cycle: an occupant blank at its
 * compact rung was dropped from the placement, read back here as rung 0,
 * rendered its full form, was demoted to compact, and vanished again — for ever.
 * Anyone who makes a blank rung offerable again brings that back.
 */
function rungOf(placement: Placement, id: string): number | null {
  return placement.has(id) ? (placement.get(id) ?? null) : 0;
}

/**
 * The rung an occupant of the AUTHORED bucket ({@link AdaptiveBarCollapsed})
 * sits at. The default flips: an occupant nothing has been decided about is
 * behind the `⋯`, because that is what the author asked for. Only the one case
 * the collapsed pass rules otherwise — a single present occupant, recorded as
 * rung 0 — comes back inline (see that pass for why).
 */
function collapsedRungOf(placement: Placement, id: string): number | null {
  return placement.get(id) === 0 ? 0 : null;
}

function AdaptiveBarShell({
  gap,
  label,
  overflow,
  align,
  spill,
  collapsed,
  className,
  children,
}: {
  gap: SpaceStep;
  label: string;
  overflow: AdaptiveBarOverflow;
  align: AdaptiveBarAlign;
  spill: boolean;
  collapsed: boolean;
  className?: string;
  children: ReactNode;
}): ReactElement {
  const { measure, isRendered } = useMeasureBundle();
  const layoutMeasured = useLayoutMeasured();
  const editMode = useEditMode();

  /**
   * Is there already a bar above this one?
   *
   * A structural fact, read where every other structural fact is read: the
   * registry a bar publishes for its own occupants is the same context a bar
   * nested inside one of them sees. `null` — the overwhelmingly common case —
   * is a bar in an ordinary row.
   *
   * `collapsed` is the whole exclusion, and it is not a special case being
   * carved out: `.Collapsed` is one `shrink-0` `⋯`, it never measures, and it
   * never asks for the row's grow, so it is not a second claimant on anything.
   * `reorder`'s `overflow` node type renders exactly that inside a pane header,
   * which is a composition that ships today and must stay silent.
   */
  const parentBar = useContext(BarRegistryContext);
  const nestedInBar = !collapsed && parentBar !== null;

  // The bar asks for its own room. Its whole premise is that
  // `root.getBoundingClientRect().width` is a width it was GIVEN, which holds
  // only if every box between it and its row relays the grow — so it says so
  // from where it is rendered rather than relying on a `fill: true` declared on
  // a contribution several files away, which is a thing two of two consumers
  // forgot. `.Collapsed` is one rigid `⋯` and asks for nothing.
  //
  // `granted` is not decoration: relays apply the grow in a state update from
  // this hook's layout effect, which React flushes AFTER every layout effect of
  // the commit — including the reconcile below. Deciding on that first reading
  // would judge the un-grown box, and `no-slack` latches.
  const grow = useRequestGrow(!collapsed);

  // Nodes are tracked as STATE via callback refs, not as refs read during
  // render: the reconcile pass must re-run when one attaches, and a ref would
  // give it no way to know.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [panelDock, setPanelDock] = useState<HTMLElement | null>(null);
  const [parkingDock, setParkingDock] = useState<HTMLElement | null>(null);
  // This bar's own region attributes: stamped on the panel's dock, and the
  // baseline each occupant stamps only its differences from.
  const regionAttrs = useRegionForwardedAttrs();

  const [placement, setPlacement] = useState<Placement>(EMPTY_PLACEMENT);
  const [panelOpen, setPanelOpen] = useState(false);

  /**
   * The bar has stopped believing its own width, and renders every occupant
   * inline forever.
   *
   * Reached only from a fault, and it is the honest floor for one: when the
   * width reading is a lie, "everything in the row, clipped by CSS" is the one
   * configuration that hides nothing and cannot be argued with. The narrow
   * floor (`commitFloor`) is the opposite — it takes occupants OUT of the row,
   * which is exactly the outcome a bad width reading was already producing.
   *
   * Latching matters as much as the layout: without it the recovery re-measures,
   * re-decides, re-evicts, and oscillates forever against a host that cannot
   * give it a straight answer.
   */
  const [degraded, setDegraded] = useState(false);
  /**
   * What the rest of the component reads. `EMPTY_PLACEMENT` has no entry for
   * anyone, and `rungOf` reads a missing entry as rung 0 — so "degraded" IS
   * "everyone inline at their widest", with no second code path to keep in step.
   */
  const effective = degraded ? EMPTY_PLACEMENT : placement;

  // Everything the next decision reads but nobody renders. Bumping `version` is
  // how a change here asks for a pass; the entries themselves never live in
  // React state, so a pointer-down that changes nothing on screen re-renders
  // nothing.
  const entriesRef = useRef(new Map<string, BarItemEntry>());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  /**
   * This bar's one yielding child, or `null` while it has none. The element IS
   * the claim — a second `<AdaptiveBar.Yield>` is one arriving while this is
   * already set — and it is what the floor is read off.
   *
   * A ref rather than state: nothing renders differently for it, and the one
   * thing that reads it (the floor, per pass) runs in a layout effect.
   */
  const yieldCellRef = useRef<HTMLElement | null>(null);
  /**
   * Whether the last pass reserved a floor for that cell — i.e. whether it was
   * rendering anything. What the content-changed signal compares against, so a
   * cell re-rendering its own internals does not cost a fit pass.
   */
  const yieldReservedRef = useRef(false);

  /**
   * The declared ladders, mirrored into React state.
   *
   * The rest of an entry (container, holds, popup, pointer lock) stays in the
   * ref: it is decision input, not something anyone renders. A ladder is
   * different — it is what turns a rung into a FORM, and the form has to reach
   * the widget through a render. Deriving it by reading the ref during render
   * would also be a lie about reactivity: the ref can change without React
   * knowing, so the derived map would silently go stale.
   */
  const [ladders, setLadders] = useState<
    ReadonlyMap<string, Required<ShrinkLadder>>
  >(() => new Map());
  const putLadder = useCallback(
    (id: string, ladder: Required<ShrinkLadder> | null): void => {
      setLadders((prev) => {
        if (ladder === null) {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        }
        if (prev.get(id) === ladder) return prev;
        const next = new Map(prev);
        next.set(id, ladder);
        return next;
      });
    },
    [],
  );

  const cacheRef = useRef<WidthCache>(emptyWidthCache);
  /** H2: rungs a committed promotion measured as not fitting, barred until the row is wider. */
  const blockedRef = useRef<BlockedRungs>(emptyBlockedRungs);
  /**
   * Rungs an occupant has been observed to render NOTHING at, so the bar stops
   * offering them. See `core/absent-rungs.ts` — this is what makes "the fit put
   * a widget where it vanishes, then un-placed it for having vanished"
   * unspellable rather than merely rare.
   */
  const absentRef = useRef<AbsentRungs>(noAbsentRungs);
  const episodeRef = useRef<Episode>(newEpisode());
  const triggerWidthRef = useRef<number | null>(null);
  /**
   * The width the grow-cell premise was last VERIFIED at, and the probes spent
   * verifying it. The premise belongs to the host, so a host that changes after
   * mount has to be caught — see {@link MAX_SLACK_PROBES} for why the re-ask
   * follows the row narrowing and why it is budgeted.
   */
  const slackVerifiedAtRef = useRef<number | null>(null);
  const slackProbesRef = useRef(0);
  /**
   * How many times this bar has re-admitted its occupants to re-ask a zero
   * width, since the last time it reached a settled answer.
   *
   * See {@link MAX_ZERO_RECOVERIES} for what the recovery is and why the bound
   * is scoped to "since the last convergence" rather than to the mount.
   */
  const zeroRecoveriesRef = useRef(0);
  /**
   * Whether this bar has already said that its row is over-full — the answer a
   * recovery comes back with when the zero was never the bar's own doing. Said
   * once per mount: the state is recoverable and self-healing, so it is worth
   * knowing about and not worth repeating.
   */
  const overFullReportedRef = useRef(false);
  /**
   * This bar has stopped deciding, and the width it stopped at. See
   * {@link commitFloor}: a fault-forced floor is the last placement computed
   * for THIS width, and the bar re-arms only when the row genuinely resizes.
   */
  const surrenderedRef = useRef(false);
  const surrenderedAtRef = useRef<number | null>(null);
  const surrenderCountRef = useRef(0);
  const surrender = useMemo<Surrender>(
    () => ({
      surrendered: surrenderedRef,
      at: surrenderedAtRef,
      count: surrenderCountRef,
    }),
    [],
  );

  const registry = useMemo<BarRegistry>(
    () => ({
      editMode,
      register(id, container) {
        const entry: BarItemEntry = {
          id,
          container,
          ladder: entriesRef.current.get(id)?.ladder ?? DEFAULT_LADDER,
          declaredRungs: null,
          holds: 0,
          popupOpen: false,
          pointerPinned: false,
          immovable: false,
        };
        entriesRef.current.set(id, entry);
        putLadder(id, entry.ladder);
        bump();
        return () => {
          if (entriesRef.current.get(id) === entry)
            entriesRef.current.delete(id);
          // The item left for good, so its measurements are not an estimate of
          // anything — unlike a rung the item merely is not sitting at, which is
          // deliberately kept.
          cacheRef.current = dropItem(cacheRef.current, id);
          blockedRef.current = unbarItem(blockedRef.current, id);
          absentRef.current = clearAbsentRungs(absentRef.current, id);
          episodeRef.current.promoted.delete(id);
          putLadder(id, null);
          bump();
        };
      },
      declare(id, ladder) {
        const entry = entriesRef.current.get(id);
        if (entry === undefined) return () => {};
        entry.ladder = ladder;
        // A ladder change can change the rung count, which changes what the
        // cached widths mean — but only the widths for rungs that still exist
        // survive, and `inlineWidthsFor` reads exactly that many.
        //
        // H2's bookkeeping is not so lucky, and both halves of it go: a rung
        // index only means anything against a ladder, so a bar recorded against
        // the old one names a different form entirely — worse than stale.
        //
        // Gated on the rungs REALLY changing, and that gate is load-bearing
        // rather than an optimisation. This runs again on every FORM change (the
        // item's channel carries its assigned form, so its declaration effect
        // re-runs whenever the bar moves it a rung) — so an ungated invalidation
        // would tear H2's bar down one passive effect after the pass that
        // installed it, and the promote-measure-demote cycle H2 exists to stop
        // would run forever, one converged episode at a time, with no counter
        // able to see it.
        const rungs = inlineRungsOf(ladder).join(",");
        if (entry.declaredRungs !== rungs) {
          entry.declaredRungs = rungs;
          blockedRef.current = unbarItem(blockedRef.current, id);
          // And what it renders at each of them. A rung index only means
          // anything against a ladder, so "renders nothing at rung 1" recorded
          // against the old one names a different form entirely.
          absentRef.current = clearAbsentRungs(absentRef.current, id);
          episodeRef.current.promoted.delete(id);
        }
        putLadder(id, ladder);
        bump();
        return () => {
          const live = entriesRef.current.get(id);
          if (live !== entry) return;
          // Only the declaration still in force may withdraw itself. A second
          // declarer on one item (a control nested inside a widget that forgot
          // `ActionFormShield`) replaces the first; letting ITS release reset
          // the item would wipe the ladder of a widget that is still mounted
          // and still declaring — which is how a stepper lost its compact rung
          // the moment its arrows unmounted.
          if (live.ladder !== ladder) return;
          live.ladder = DEFAULT_LADDER;
          putLadder(id, DEFAULT_LADDER);
          bump();
        };
      },
      hold(id) {
        const entry = entriesRef.current.get(id);
        if (entry === undefined) return () => {};
        entry.holds += 1;
        // NO bump: a freeze changes nothing about the current layout. The
        // RELEASE bumps, which is what makes "deferred forever" unrepresentable.
        return () => {
          entry.holds -= 1;
          bump();
        };
      },
      setPopupOpen(id, open) {
        const entry = entriesRef.current.get(id);
        if (entry === undefined || entry.popupOpen === open) return;
        entry.popupOpen = open;
        // Same asymmetry as `hold`: opening freezes and changes nothing on
        // screen; closing is what releases a stored target.
        if (!open) bump();
      },
      contentChanged(id) {
        const entry = entriesRef.current.get(id);
        if (entry === undefined) return;
        // `hidden` is where the last pass recorded absence, so this compares
        // the new truth against the committed one and stays quiet otherwise —
        // a widget re-rendering its own internals must not cost a fit pass.
        const absent = rendersNothing(entry.container);
        if (absent !== (entry.container.hidden === true)) bump();
      },
      claimYield(cell) {
        if (yieldCellRef.current !== null) {
          throw new Error(
            "adaptive-bar: a bar has at most one <AdaptiveBar.Yield>. It is the row's give — the one child excluded from the fit ledger and allowed below its own content width — so two of them would split the leftover between themselves and both ellipsize, decided by their content rather than by the author. Make the second one an <AdaptiveBar.Item>, which the fit can size and relocate.",
          );
        }
        yieldCellRef.current = cell;
        // The budget just lost this cell's floor, which is a smaller row for
        // everyone else — so it is decided again rather than at the next resize.
        bump();
        return () => {
          if (yieldCellRef.current !== cell) return;
          yieldCellRef.current = null;
          yieldReservedRef.current = false;
          bump();
        };
      },
      yieldContentChanged() {
        const cell = yieldCellRef.current;
        if (cell === null) return;
        // `yieldReservedRef` is what the last pass decided from, so this
        // compares the new truth against the committed one and stays quiet
        // otherwise — the same discipline as `contentChanged` above.
        if (yieldFloorPx(cell) > 0 !== yieldReservedRef.current) bump();
      },
    }),
    [editMode, bump, putLadder],
  );

  /**
   * The form each occupant renders at. Derived, never stored: the placement is
   * the state, and a second stored copy of the same fact is a second thing that
   * can be stale.
   */
  const forms = useMemo<ReadonlyMap<string, ActionForm>>(() => {
    const map = new Map<string, ActionForm>();
    for (const [id, ladder] of ladders) {
      map.set(
        id,
        formFor(
          ladder,
          collapsed ? collapsedRungOf(effective, id) : rungOf(effective, id),
        ),
      );
    }
    return map;
  }, [ladders, effective, collapsed]);

  // An `⋯` with nothing behind it is dead chrome, so the trigger follows the
  // placement rather than the item count — including in the collapsed bucket,
  // where a contribution that rendered nothing is absent from the placement for
  // exactly this reason.
  const evictedCount = useMemo(() => {
    let n = 0;
    for (const rung of effective.values()) if (rung === null) n += 1;
    return n;
  }, [effective]);

  const showTrigger = overflow === "panel" && evictedCount > 0;

  /**
   * One pass: apply the committed placement to the DOM, measure what is now
   * inline, and decide the next placement.
   *
   * Split that way because a rung is React state — a widget only renders its
   * compact form after a commit — so a pass cannot both decide and observe the
   * consequence. Docking, by contrast, is pure DOM and happens here, following
   * the placement React has already committed. The loop terminates by the
   * placement repeating, not by a fixed number of rounds; the round budget is
   * the assertion that it does.
   */
  const reconcile = useCallback((): void => {
    if (root === null) return;
    // Not yet the width this bar will have: a relay above it has taken the ask
    // and has not applied the grow yet. Settles inside this same pre-paint
    // layout phase (one sync pass per relay), and `grow.granted` is in this
    // callback's closure, so the pass re-runs the moment it flips.
    if (!grow.granted) return;
    const entries = entriesRef.current;

    // ── Order, straight from the DOM ──────────────────────────────────────
    // Document order of the anchors IS the order the host produced, reorder
    // middleware and all. Nothing else can be trusted: mount order gets a
    // mid-list insertion wrong, and a consumer-declared order is a second
    // source of truth for something the DOM already knows.
    const anchors = [
      ...root.querySelectorAll<HTMLElement>("[data-adaptive-bar-anchor]"),
    ];
    const order: { id: string; anchor: HTMLElement; entry: BarItemEntry }[] =
      [];
    for (const anchor of anchors) {
      const id = anchor.getAttribute("data-adaptive-bar-anchor");
      const entry = id === null ? undefined : entries.get(id);
      if (id !== null && entry !== undefined) order.push({ id, anchor, entry });
    }

    // ── 1. Apply the committed placement ──────────────────────────────────
    const evicted: string[] = [];
    for (const { id, anchor, entry } of order) {
      const absent = rendersNothing(entry.container);
      // An absent occupant contributes no width AND NO GAP. A 0×0 flex item
      // would still be paid for on both sides, so absence has to be `hidden`
      // (not a flex item at all) rather than a zero width.
      entry.container.hidden = absent;
      const rung = collapsed
        ? collapsedRungOf(effective, id)
        : rungOf(effective, id);
      if (rung === null && !absent) {
        evicted.push(id);
      } else {
        // Against the ANCHOR's parent, not the bar root — see `dockInline`.
        // Through a `display: contents` chain the container is still a flex item
        // of this row, so gap and measurement are unchanged.
        dockInline(entry.container, anchor);
      }
    }
    // ORDER IS LOAD-BEARING: the inline loop above ran first, and that is what
    // discharges `dockGroup`'s "no strays" precondition. An occupant coming back
    // from the panel to the row has already been pulled out by its own
    // `dockInline`, so the eviction dock holds nothing absent from `evicted` and
    // `planMoves`' `beforeId: null` genuinely means "append". Running this pass
    // first would leave a returning occupant sitting in the dock while the plan
    // assumed it gone.
    const evictionDock = overflow === "panel" ? panelDock : parkingDock;
    if (evictionDock !== null) {
      dockGroup(evictionDock, evicted, (id) => entries.get(id)?.container);
    }
    // A panel that has just emptied is dead chrome holding focus, so it closes.
    // This is the ONE placement-driven close, and it lives here rather than in
    // an effect because "the panel became empty" is a fact this pass computed.
    // A resize alone never closes it.
    if (evicted.length === 0) setPanelOpen(false);

    // Degraded: the placement above IS "everyone inline", and there is nothing
    // left to decide. Returning here rather than skipping the whole pass keeps
    // a late-arriving occupant docked like the rest.
    if (degraded) return;

    // A bar written inside another bar's occupant has the same nothing to
    // decide, and it stops here rather than only in the effect that reports it:
    // a `setDegraded` made in an earlier layout effect of THIS commit is not
    // visible to this pass's closure, so without this the inner bar would spend
    // one pass measuring a `shrink-0` container's width — and file `no-slack`
    // about it, one commit before the fault that names what is really wrong.
    if (nestedInBar) return;

    // The authored bucket has no width to consult — membership is the author's
    // decision, so there is nothing to measure and nothing to converge.
    //
    // This return has to stay ABOVE the measurement, and the zero-width recovery
    // below is why it is worth saying so. A collapsed bar puts EVERY occupant
    // out of the row unconditionally, so it always looks like "occupants
    // relocated out of a row measuring nothing" — and a recovery there would
    // commit the ceiling only for this branch to put everything straight back
    // out on the next pass, for ever.
    //
    // One exception, and it is about the `⋯`, not about width: a bucket whose
    // members came to ONE on this row would put a single action behind a menu
    // trigger that costs the same click and the same room as the action itself.
    // So a lone present occupant stays inline at its full rung, and the trigger
    // (which follows the evicted count) is not painted. Presence is per row —
    // members that rendered nothing were recorded `hidden` above — so the same
    // authored bucket is a `⋯` on one row and a plain button on the next.
    if (collapsed) {
      const present = order.filter(
        ({ entry }) => entry.container.hidden !== true,
      );
      const lone = present.length === 1;
      const next = new Map<string, number | null>();
      for (const { id } of present) next.set(id, lone ? 0 : null);
      if (!samePlacement(next, placement)) setPlacement(next);
      return;
    }

    // ── 2. Measure ────────────────────────────────────────────────────────
    // The CONTENT box, not the border box. The occupants are laid out inside
    // the row's padding and border, and `measureRowOverflow` judges them
    // against that same box — so a budget that included the padding would be a
    // budget for room that does not exist, and the fault it produced would be
    // the fit's arithmetic accusing the layout.
    const metrics = readRowMetrics(root);
    // Kept as read, not just as the budget: the slack probe compares the row
    // holding its occupants against the row without them, and this IS the
    // holding-them reading. Taking it twice would be a second forced reflow of
    // a layout nothing has touched in between — and, in a test fake that models
    // a pane being dragged, a second reading is a second drag step.
    const rowPx = measure(root);
    const available = rowPx - metrics.insetPx;
    // Zero available width is not a width. Deciding from it would evict the
    // whole row and then put it back, so we decide nothing and wait for one.
    //
    // With occupants already OUT of the row, a zero CAN be the bar's own doing —
    // an empty row measures empty — and then waiting is waiting for a width that
    // only re-admitting them could produce. That is the one absorbing state this
    // primitive can reach, so it is not a pause. It is also not a verdict: see
    // the recovery below.
    //
    // But only if the row generates a box at all. An element in a `display:
    // none` subtree was never given a width: reading 0 off it is not a reading,
    // it is the ABSENCE of one, and this app keeps whole surfaces mounted-but-
    // not-rendered as a matter of course — an unfocused tab
    // (`apps-core/plugins/surface/web/components/surface-body.tsx`), a minimized
    // floating window (`apps-core/plugins/surface/plugins/floating/…`), a
    // collapsed miller column (`layouts/plugins/miller/web/components/column.tsx`).
    // That is a first-class state, not a broken host. Treating its 0 as a width
    // is an absorbable failure value (root `CLAUDE.md`), and the act it triggers
    // — `degraded` — latches for the life of the mount, so the surface pays for
    // the mistake until it remounts. The quiet return keeps whatever placement
    // the bar last committed, and the bar decides again from a real width the
    // moment it is shown.
    //
    // `isRendered` costs nothing: it is asked only on the path that already read
    // zero AND has evictions, after `measure(root)` flushed layout — so it
    // forces no reflow of its own.
    //
    // And a row that DOES generate a box, and still measures nothing with
    // occupants parked outside it, is two different things that this number
    // cannot tell apart:
    //
    // - the ratchet at its end. The host shrink-wraps to the bar, so every
    //   eviction shrank the width that decided the next one, and the row has
    //   emptied itself. A real fault, and the ceiling is the right remedy.
    // - a merely OVER-FULL row. `flex-1` is `flex: 1 1 0%`: when the row's other
    //   items over-fill their container, free space is negative, and a cell
    //   whose base size is 0 has no basis to absorb a share of it — so it
    //   resolves to exactly 0px while fully laid out. Nothing is wrong with the
    //   host and nothing is wrong with the bar. There is no room at this width,
    //   and there will be again when the row widens. Latching here would take
    //   the relocation behaviour away for the life of the mount over a row that
    //   is merely cramped.
    //
    // So do not decide it from a number that carries no answer — restore the
    // conditions under which the guard that CAN answer will run, and let it. The
    // recovery re-admits everything, clears the premise watermark and refunds a
    // probe, which splits the two cases on the very next pass: a shrink-wrapping
    // host now measures its own content, so the probe below runs and faults in
    // the words that name the defect; an over-full row measures nothing again
    // but has nothing evicted any more, so this branch declines it and the pass
    // is the ordinary "no width yet" pause, which recovers by itself the moment
    // the row widens. {@link MAX_ZERO_RECOVERIES} is where the bound and its
    // termination argument are written down.
    if (available <= 0) {
      if (evicted.length > 0 && isRendered(root)) {
        // A gesture holds one of the occupants. Re-admitting would re-parent it
        // out of the body-portaled panel mid-drag — pointer capture released,
        // top layer dropped, transition restarted, the whole list the pointer
        // lock exists to prevent. Deferred, never dropped: every release bumps,
        // so the pass runs again the moment the gesture ends.
        //
        // `immovable` is deliberately NOT in this predicate, unlike the fit's
        // own `pinned`: it never clears, so including it would defer for ever
        // and leave a 0px row with nothing to say for itself. An immovable
        // occupant is never evicted anyway, so re-admitting costs it nothing.
        const gestured = order.some(
          ({ entry }) =>
            entry.holds > 0 || entry.popupOpen || entry.pointerPinned,
        );
        if (gestured) return;
        if (zeroRecoveriesRef.current < MAX_ZERO_RECOVERIES) {
          zeroRecoveriesRef.current += 1;
          // Load-bearing, not tidiness: leaving the old watermark in place
          // would make the WIDER re-admitted width read as already verified,
          // the probe would not run, and the whole re-ask would fail silently.
          slackVerifiedAtRef.current = null;
          // Reserve a probe rather than refund one. `n - 1` would manufacture
          // budget — spend-then-refund nets to zero, and `MAX_SLACK_PROBES`
          // would stop bounding reflows at all. This guarantees exactly what
          // the re-ask needs: that one probe is available to answer it.
          slackProbesRef.current = Math.min(
            slackProbesRef.current,
            MAX_SLACK_PROBES - 1,
          );
          // H2's evidence goes with the placement it was evidence ABOUT. This
          // branch returns above the premise block, so a promotion recorded
          // before the collapse would otherwise survive the re-admission and
          // bar a rung on the strength of a search that no longer exists —
          // exactly what `startEpisode` clears it for.
          episodeRef.current.promoted.clear();
          // The ceiling as a PLACEMENT, not as `degraded`: the same layout —
          // `rungOf` reads a missing entry as rung 0, so this is everyone inline
          // at their widest — but one the next pass is free to leave again.
          //
          // Never a no-op commit, and the invariant is worth stating because a
          // silent bail-out here would tick the counter without ever re-admitting
          // anything: `evicted` requires `rungOf` to have returned `null`, which
          // requires `placement.has(id)`, which an empty map cannot satisfy. So
          // `placement` is never `EMPTY_PLACEMENT` on this path.
          //
          // It can also re-arm a surrendered bar, since the re-admitted width
          // differs from the width it surrendered at. That is the right outcome
          // — the floor evidently did not help — and `MAX_SURRENDERS` bounds it.
          setPlacement(EMPTY_PLACEMENT);
        } else {
          setDegraded(true);
          failLoudly({
            kind: "no-slack",
            label,
            overflow,
            ...originOf(root),
            message: `the row measured 0px wide while occupants were relocated out of it, and it does generate a box — so this is a width its host really gave it. Re-admitting every occupant ${String(MAX_ZERO_RECOVERIES)} times never produced a width the slack probe could judge, so the bar has stopped deciding: everything back in the row, CSS clips. Two hosts reach this. One shrink-wraps to the bar, so every eviction shrinks the width that decides the next one — put the bar where there is room to give: as the growing cell of a single-line row, with no Fill or other flex-1 sibling competing for the same slack, and never inside a shrink-to-content parent (inline-flex, w-fit, Cluster). The other is a row so over-full that the bar's flex-1 cell (base size 0) has nothing left to resolve to — there the fix is the bar's SIBLINGS, which are taking more than the row has. ${relayNote(grow.relays)}`,
          });
        }
      } else if (
        zeroRecoveriesRef.current > 0 &&
        !overFullReportedRef.current &&
        isRendered(root)
      ) {
        // The re-admission ANSWERED. This row holds every occupant it has, is
        // fully rendered, and still measures nothing — so the zero did not come
        // from the bar's own evictions and never could have: the row it sits in
        // is over-full, and `flex: 1 1 0%` against negative free space resolves
        // this cell to exactly nothing.
        //
        // Reported, and reported once, because the alternative is silence about
        // an invisible toolbar: at 0px with `overflow-hidden` every occupant AND
        // the `⋯` trigger are clipped away, and a surface that shows nothing
        // with nothing filed is the outcome this primitive's guards exist to
        // prevent. `reportFault` rather than `failLoudly` — nothing is latched,
        // nothing throws, and the bar goes straight back to work when the row
        // has room. The same discipline as `empty-rung`: handled correctly, and
        // still worth knowing.
        //
        // Gated on a recovery having happened, which is what makes it evidence
        // rather than a guess — and what keeps it away from the ordinary
        // "not laid out yet" pause and from the `display: none` case, which
        // never recovers because `isRendered` refuses it first.
        overFullReportedRef.current = true;
        reportFault({
          kind: "no-slack",
          label,
          overflow,
          ...originOf(root),
          message:
            "the bar's own cell resolved to 0px while it was fully rendered and holding every occupant it has — so the row it sits in is over-full: its other cells' content leaves negative free space, and flex: 1 1 0% resolves this cell to nothing. Everything the bar holds, the ⋯ trigger included, is clipped to invisibility at that width. Nothing was evicted and nothing has been latched: the bar decides again as soon as the row has room. The fix is on the SIBLING cells — make one of them shrinkable (min-w-0, or a truncating leaf) so the row stops over-filling.",
        });
      }
      return;
    }

    // ── The yielding cell's floor ─────────────────────────────────────────
    // The room the occupants may NOT have, so that the one child which can
    // shrink is not the one that pays for all of them.
    //
    // The yielding cell is `min-w-0` among rigid neighbours, so flex takes the
    // whole deficit out of it first — and while it can still give, the row does
    // not overflow, `assign` sees a total that fits, and nothing is ever
    // demoted or relocated. A pane title therefore went to "Une" and then to
    // nothing while ten header widgets sat inline. Reserving its floor is the
    // whole mechanism: the search is handed a smaller row, so pressure past the
    // floor IS overflow and is paid for the ordinary way — by an occupant
    // moving into the `⋯`.
    //
    // Above the floor nothing changes: the cell still absorbs every pixel the
    // occupants leave, so a roomy header is laid out exactly as before. Zero
    // when there is no yielding child, and zero when it renders nothing — an
    // empty cell has no legibility to protect, and a title-less header must
    // land its actions where it always did.
    const yieldFloor = yieldFloorPx(yieldCellRef.current);
    yieldReservedRef.current = yieldFloor > 0;
    /**
     * What the search is handed, as against `available`, which is what the ROW
     * has. The two are the same number until a yielding cell reserves its
     * floor, and they are kept apart because they answer different questions:
     * `available` is a fact about the host (did it give this bar a width at
     * all, does its width follow its own content), and the guards that ask
     * those questions must not see a width the bar itself subtracted from.
     *
     * Never negative — the difference between "no room for the occupants" and
     * "no width" is the whole `available <= 0` branch above, and manufacturing
     * the second from the first would send a merely-narrow row through the
     * zero-width recovery and, in the end, latch a fault on a healthy host.
     * Clamped, a row narrower than the floor is an ordinary total overflow: the
     * fit seats nobody, every evictable occupant relocates behind the `⋯`, and
     * the cell keeps whatever the trigger leaves — below its floor, because
     * there is nothing left to take it from. Stable, because the clamp holds
     * the budget at 0 however much narrower the row gets.
     */
    const budget = Math.max(0, available - yieldFloor);

    // The bar's whole premise: `available` is handed to it and does not move
    // when it decides. Tested against the layout engine rather than inferred
    // from a style — `flex-grow: 1` is no promise of slack when an ancestor
    // shrink-wraps, and that shape reads as healthy on every proxy.
    //
    // Asked again whenever the row is narrower than the width the premise last
    // held at, because the premise is a property of the host and the host can
    // change under a mounted bar. Narrowing is the ratchet's own direction and
    // the moment a masked shrink-wrap first bites; `MAX_SLACK_PROBES` bounds
    // what that costs during a drag.
    const verifiedAt = slackVerifiedAtRef.current;
    const unverified =
      verifiedAt === null || available < verifiedAt - HYSTERESIS_PX;
    if (unverified && slackProbesRef.current < MAX_SLACK_PROBES) {
      const inline = order
        .filter(
          ({ anchor, entry }) =>
            isDockedInline(entry.container, anchor) &&
            entry.container.hidden !== true,
        )
        .map(({ entry }) => entry.container);
      // A probe with nothing in the row proves nothing: hiding no occupants
      // changes no width, and the two readings agree for the wrong reason.
      if (inline.length > 0) {
        // Before the probe, not after: a dev throw must leave the probe spent,
        // or the fault re-arms itself on the way back out.
        slackProbesRef.current += 1;
        slackVerifiedAtRef.current = available;
        if (widthFollowsContent(root, inline, measure, rowPx)) {
          setDegraded(true);
          failLoudly({
            kind: "no-slack",
            label,
            overflow,
            ...originOf(root),
            message: `the bar's own width moves with its own content, so every eviction shrinks the width that decides the next one — a one-way ratchet with an empty row at the end of it. Put it where there is room to give: as the growing cell of a single-line row, with no Fill or other flex-1 sibling competing for the same slack, and never inside a shrink-to-content parent (inline-flex, w-fit, Cluster, or a wrapper that relays shrink but not grow). One adaptive bar per row. ${relayNote(grow.relays)}`,
          });
          return;
        }
      }
    }

    // ── The stop ──────────────────────────────────────────────────────────
    // A surrendered bar still DOCKS — section 1 ran, so an occupant that
    // mounted or unmounted since is placed correctly — but it does not decide.
    // Everything below is the search, and a fault says the search cannot be
    // trusted AT THIS WIDTH.
    //
    // Below the measurement rather than above it, because "has the premise
    // changed" is a question about the width. A resize is the one event that
    // makes re-deriving legitimate, and it cannot be self-inflicted: the bar is
    // the grow cell, so this number comes from its row and never from its own
    // content — which the slack probe just above has now VERIFIED of the layout
    // engine rather than assumed. `MAX_SURRENDERS` is the backstop anyway.
    if (surrenderedRef.current) {
      const surrenderedAt = surrenderedAtRef.current;
      // In the SEARCH's currency (`budget`), because that is what the surrender
      // was stamped with and what it was about: a bar stops deciding because it
      // could not fit the occupants in the room it had, and the room it had is
      // the row minus the yielding cell's floor. The two currencies differ by a
      // constant, so this is the same test at the same widths — except when the
      // floor itself changes, and a title arriving genuinely IS a change in the
      // room the search failed at.
      const resized =
        surrenderedAt === null ||
        Math.abs(budget - surrenderedAt) > HYSTERESIS_PX;
      if (!resized || surrenderCountRef.current >= MAX_SURRENDERS) return;
      surrenderedRef.current = false;
      startEpisode(episodeRef.current);
    }

    const gapPx = metrics.gapPx;
    const triggerPx =
      overflow === "panel"
        ? measureTrigger(trigger, measure, triggerWidthRef)
        : 0;

    /** Every occupant this pass could legitimately read — the round's premise. */
    const measured: RoundItem[] = [];
    for (const { id, anchor, entry } of order) {
      const rung = rungOf(placement, id);
      if (rung === null) continue;
      // Only an INLINE node is measurable. A width read in the panel describes
      // the panel's layout, not the row's, and would poison every later fit —
      // `write` refuses it, and this is the caller half of that contract.
      // "Inline" is "docked at its own anchor", never "a child of the root":
      // the anchor is as deep as the host put it.
      if (!isDockedInline(entry.container, anchor)) continue;

      // ── The occupant rendered nothing, and this is where that is learned ──
      //
      // "Renders nothing" is a fact about this occupant AT THIS RUNG, and an
      // inline pass is the only place it can be read. Recorded as such (see
      // `core/absent-rungs.ts`), so the bar stops OFFERING a rung the widget
      // vanishes on — rather than concluding the occupant itself is nothing,
      // dropping it from the placement, reading the hole as rung 0 next round,
      // and flipping between the two for ever.
      //
      // Nothing is measured here on purpose: a hidden element reports 0 because
      // it generates no box, not because it is 0 wide, and the ledger's
      // discipline is that absence is decided from the DOM and never from a 0
      // (`write` refuses one outright).
      if (entry.container.hidden === true) {
        // A rung outside the declared ladder is stale bookkeeping (the widget
        // re-declared a shorter one and the placement has not caught up), so
        // there is no form to name and nothing true to record about it. The next
        // pass clamps it; see `clampCurrent`.
        const declaredRungs = inlineRungsOf(entry.ladder).length;
        if (
          rung < declaredRungs &&
          !isAbsentRung(absentRef.current, id, rung)
        ) {
          absentRef.current = markAbsentRung(absentRef.current, id, rung);
          // Its H2 bars go: a bar says "this rung did not fit", which was a
          // claim about content the occupant is evidently no longer rendering.
          blockedRef.current = unbarItem(blockedRef.current, id);
          // The WIDTHS deliberately do not, and the symmetry is a trap. The
          // ladder has just been cut to this rung, so downgrading rung 0 leaves
          // it with no wider rung to bound it: `resolveWidth` reports
          // `unbounded`, `doesFit` is false at EVERY width, and the search walks
          // every other occupant out of the row to pay for one widget's blank
          // form. Nothing is lost by leaving them — this pass measured nothing
          // (a hidden element has no box to read), and any width below the cut
          // is unreachable until the mark is cleared, which only the
          // content-changed clause below does, having downgraded them already.
          //
          // Rung 0 blank is the ordinary supported case — a contribution that
          // renders nothing — and is nobody's bug. A blank rung BELOW it is a
          // widget that declared a form and does not render it, which the bar
          // now recovers from silently and which nobody would otherwise ever
          // find out about.
          if (rung > 0) {
            const form = formFor(entry.ladder, rung);
            reportFault({
              kind: "empty-rung",
              label,
              overflow,
              ...originOf(root),
              item: { id, rung, form },
              message: `bar item "${id}" declared a "${form}" form and then rendered nothing as one. That form is not offered to it again: the widget stays at its widest form and leaves the row when the row runs out of room. Render something as "${form}", or stop declaring it — a widget that cannot render a form right now should not be offering it.`,
            });
          }
        }
        continue;
      }

      const px = measure(entry.container);
      measured.push({ id, rung, px });
      const known = estimate(cacheRef.current, id, rung);
      // ── What this occupant renders has changed ────────────────────────────
      // Two ways to notice it, one conclusion. Either it measures differently at
      // a rung it was already sitting at, or it is rendering at a rung recorded
      // blank — reachable only at rung 0, since a blank rung above that is never
      // offered again and so is never sat on.
      const rendersAgain = isAbsentRung(absentRef.current, id, rung);
      if (rendersAgain || (known.kind === "exact" && known.px !== px)) {
        // The item's own size changed, so what we believe about its OTHER rungs
        // is hearsay. Kept as estimates rather than deleted: an item sitting at
        // rung 1 is only measurable at rung 1, so dropping the rest would strand
        // it there forever.
        cacheRef.current = staleOthers(cacheRef.current, id, rung);
        // Its bars go outright, though. A bar says "this rung did not fit", and
        // that was a statement about the content this occupant was rendering at
        // the time — content whose size has just moved, so the rejection is
        // about something that no longer exists.
        blockedRef.current = unbarItem(blockedRef.current, id);
        // And so do the rungs the bar stopped offering it, for exactly the same
        // reason: "renders nothing as compact" was a claim about content that
        // has since moved. This is the ONE channel by which a cut ladder grows
        // back — a blank rung above 0 is never sat on again, so nothing else can
        // ever observe it — and it costs one demote-and-measure round trip per
        // content change, the same bound H2 lives under. It cannot re-open the
        // flip: the fit's own demote/promote chain never produces a changed
        // width at an UNCHANGED rung, which is the restriction the premise check
        // rests on too.
        absentRef.current = clearAbsentRungs(absentRef.current, id);
      }
      const result = write(cacheRef.current, {
        id,
        rung,
        px,
        dockedInline: true,
      });
      // A refusal is information, not an error: a 0 means the contribution
      // rendered nothing, which the `hidden` flag above already recorded.
      if (result.ok) cacheRef.current = result.cache;
    }

    // ── The premise ───────────────────────────────────────────────────────
    // Was this round asking the same question as the last one? Only then is a
    // changed answer evidence that the search does not settle. A resize, a
    // contribution mounting, or an occupant resizing itself at a rung it was
    // already sitting at are all "somebody moved the row underneath us" — the
    // rounds before are about a width that no longer exists, so they are not
    // rounds of this search and the counter starts again.
    //
    // The restriction to an UNCHANGED rung is what keeps this from dissolving
    // the bound: an occupant that just changed rung is SUPPOSED to measure
    // differently, and treating that as a moving premise would reset the
    // counter on every round of the bar's own chain. `episode.total` bounds the
    // other side — see HARD_ROUND_CEILING.
    const episode = episodeRef.current;
    const round: Round = {
      // The premise is what the SEARCH is handed, so the round records the
      // budget rather than the row: a yielding cell that starts (or stops)
      // reserving its floor moved the room this search is about, exactly as a
      // resize does, and the rounds decided before it were about a row that no
      // longer exists.
      available: budget,
      // The ladder as DECLARED, never as currently offered. A cut ladder is
      // self-inflicted — the bar found the blank rung by putting the widget
      // there — and a premise is by definition what a decision reads that the
      // decision itself does not cause. Counting it would reset `rounds` on the
      // bar's own chain, blame the shift on "the widths underneath this bar",
      // and (worst) clear `episode.promoted`, throwing away H2's evidence for
      // every OTHER occupant in the row. A discovery is paid for on the budget
      // side instead — see `FitItem.declaredRungs`.
      shape: order
        .map(
          ({ id, entry }) =>
            `${id}:${String(inlineRungsOf(entry.ladder).length)}`,
        )
        .join(","),
      items: measured,
    };
    const previous = episode.premise;
    episode.premise = round;
    pushRound(episode.trace, round, TRACE_ROUNDS);
    if (previous !== null) {
      const shift = premiseShift(previous, round, WIDTH_EPSILON_PX);
      if (isShifted(shift)) {
        episode.rounds = 0;
        episode.shifts += 1;
        recordMoves(episode.moved, shift.moved);
        // And the promotion record goes with them. A promotion is evidence only
        // against the width, the item set and the widths it was decided at —
        // exactly what a shift says has moved. This is also the half that covers
        // every early return above without enumerating any of them: a pane that
        // collapses and reopens wider reads as a resize here, so the record from
        // before the collapse can never bar a rung at the new width.
        episode.promoted.clear();
      }
    }

    // ── 3. Decide ─────────────────────────────────────────────────────────
    // A bar's own terms are "until the row is genuinely wider than the width
    // that rejected this rung". Once it is, the bar is DISCHARGED rather than
    // dormant — so it is dropped here, at the one moment the row's width is
    // known, instead of being left to be re-evaluated months later against a row
    // that has been re-laid-out and re-measured since. Not memory hygiene: the
    // ledger is bounded by items × rungs either way.
    blockedRef.current = sweepBarred(blockedRef.current, budget, HYSTERESIS_PX);

    // THE one place "is this an occupant at all" is decided, and the one place
    // the offered ladder is derived. Everything downstream — the fit, the
    // budget, the floor, the placement — takes occupants as given, so none of
    // them repeats the rule and none of them can drift from it.
    const items: FitItem[] = [];
    for (const { id, entry } of order) {
      const declaredRungs = inlineRungsOf(entry.ladder).length;
      // What the widget declared, cut short at the first rung it has been
      // observed to render nothing at: a form a widget does not render is not a
      // form it has, so the fit is never offered it.
      const rungCount = offeredRungCount(absentRef.current, id, declaredRungs);
      // Cut to nothing: it renders nothing at every form the bar could hand it.
      // It keeps its host and its hidden container — section 1 above docked it —
      // but it is not an occupant, so it costs no width, no gap, cannot be
      // evicted, and gets no entry in the placement.
      if (rungCount === 0) continue;
      items.push({
        id,
        inlineWidths: inlineWidthsFor(cacheRef.current, id, rungCount),
        declaredRungs,
        evictable: overflow !== "scroll" && !entry.immovable,
        yieldRank: yieldRankOf(entry.ladder),
        pinned:
          entry.holds > 0 ||
          entry.popupOpen ||
          entry.pointerPinned ||
          entry.immovable,
        currentRung: rungOf(placement, id),
      });
    }

    const result = assign({
      available: budget,
      gap: gapPx,
      triggerPx,
      hysteresisPx: HYSTERESIS_PX,
      items,
      blocked: blockedRef.current,
    });
    // This round's OUTPUT, kept on the round so a repeat is recognisable as a
    // cycle in the fit rather than as a premise that keeps moving. Two different
    // defects, two different fixes, and only the evidence can tell them apart.
    round.decided = placementKey(result.placement);

    // H2: a promotion we COMMITTED, then measured, and are now undoing at the
    // same width was a promotion this row cannot afford. Bar that rung until the
    // row is genuinely wider than the width that rejected it — the failed
    // promotion measured the true width, so this costs at most one round trip
    // per (item, rung) per content change, not one per resize.
    //
    // Stamped with the width the PROMOTION was decided at, never this pass's
    // `available`. The two agree whenever the premise held, and where they do
    // not, the promotion's own width is the only one that ever rejected
    // anything.
    for (const [id, promotion] of episode.promoted) {
      const now = result.placement.get(id);
      if (now === undefined) continue;
      if (now === null || now > promotion.rung) {
        blockedRef.current = barRung(
          blockedRef.current,
          id,
          promotion.rung,
          promotion.atWidth,
        );
      }
    }

    // The best answer the search has produced so far, kept for the case where it
    // runs out of rounds. `fits` from measurements alone — an estimate can
    // refuse a fit but never fabricate one, so a `fits` reached through
    // estimates is a weaker claim than the one this fallback needs to make.
    if (result.fits && !result.usedEstimate) {
      episode.best = { placement: result.placement, available: budget };
    }

    if (samePlacement(result.placement, placement)) {
      // The episode is over: the counters, the premise and the evidence all
      // belong to a search that has finished, and carrying them into the next
      // one would blame it for rounds it never ran.
      startEpisode(episode);

      // The row-overflow guard belongs HERE, and only here.
      //
      // It compares what the fit believes against what the layout engine did —
      // so the two have to describe the SAME configuration.
      // `measureRowOverflow` measures the row as currently rendered, which is
      // the COMMITTED placement; `result` is what we are about to commit. On
      // any pass where they differ, the row on screen is the one we already
      // know is wrong and are in the middle of fixing, so checking it there
      // reports a disagreement that does not exist — and, in dev, throws over
      // it.
      //
      // Converged means rendered == blessed, which is the only state in which
      // "the fit says it fits and the row does not" is a real contradiction.
      //
      // `usedEstimate` deliberately does NOT gate this. An estimate is an upper
      // bound, so it can refuse a fit but never fabricate one: a `fits: true`
      // reached through estimates is still a claim the row fits, and an
      // overflowing row still contradicts it.
      //
      // In `scroll` mode the row overflowing IS the contract — nothing leaves
      // the row and the row scrolls — so there is no contradiction to detect.
      // The skip is mandatory rather than cosmetic: the root is user-scrollable
      // there, so the occupants' rects shift with `scrollLeft`, and flooring a
      // bar that was asked to scroll would shrink every one of them.
      if (layoutMeasured && overflow !== "scroll" && result.fits) {
        const overflowingBy = measureRowOverflow(root, order, trigger);
        if (overflowingBy > 0) {
          // The floor, unconditionally: the fit's own numbers have just been
          // contradicted by the engine, so "the widest placement the fit blessed
          // as fitting" is exactly the claim under suspicion.
          commitFloor(items, overflow, setPlacement, surrender, budget);
          failLoudly({
            kind: "row-overflow",
            label,
            overflow,
            ...originOf(root),
            message: `the fit says everything fits and the rendered row still overflows the box the bar was given, by ${String(Math.round(overflowingBy))}px — so the widths the fit decided from are not the widths the row actually has.`,
          });
          // Not a settled answer: it floored and surrendered. Falling through
          // to the clear below would refund a zero-width recovery on the way
          // out of a fault, which is the one place it must not be refunded.
          return;
        }
      }
      // A settled answer at a real width, with nothing to report — so whatever
      // a zero-width recovery was about is over, and the next one starts from
      // scratch. This is the ONLY place the counter is cleared, and it is safe
      // for a structural reason: convergence means no `setState`, so it ENDS
      // the synchronous re-entry chain. Nothing can reach here from inside one.
      // See {@link MAX_ZERO_RECOVERIES}.
      zeroRecoveriesRef.current = 0;
      return;
    }

    episode.rounds += 1;
    episode.total += 1;
    // Three bounds, three diagnoses, one remedy. They are counted separately
    // because they are different bugs with different owners, and the fault says
    // which one tripped:
    //
    // - `rounds` is the search's own cost, derived from the steps this row has
    //   to give. Over it means the fit really is not settling at a premise that
    //   held still.
    // - `shifts` means the widths under this bar never stopped moving. Not the
    //   search's fault, but not something to keep re-deciding through either.
    // - `total` is the one nothing resets. It is what makes tolerating a moving
    //   premise safe rather than unbounded — see HARD_ROUND_CEILING.
    const stopped =
      episode.rounds > passBudget(items)
        ? `the placement still changed after ${String(episode.rounds)} measure-and-decide rounds at a premise that held still`
        : episode.shifts > MAX_PREMISE_SHIFTS
          ? `the widths underneath this bar moved ${String(episode.shifts)} times without the placement ever settling`
          : episode.total > HARD_ROUND_CEILING
            ? `this bar has re-decided ${String(episode.total)} times without ever settling`
            : null;
    if (stopped !== null) {
      const evidence = summarizeRounds(episode.trace, episode.moved, {
        rounds: episode.rounds,
        shifts: episode.shifts,
        total: episode.total,
      });
      const remedy = commitSurrender(
        items,
        episode.best,
        overflow,
        setPlacement,
        surrender,
        budget,
      );
      failLoudly({
        kind: "no-convergence",
        label,
        ...originOf(root),
        overflow,
        message: `${stopped}. ${describeEvidence(evidence)} ${remedy} The bar has stopped deciding until the row is genuinely resized.`,
        evidence,
      });
      return;
    }

    // The evidence for the NEXT pass: what this one is about to commit as a
    // promotion, and the width it decided that at.
    episode.promoted.clear();
    for (const { id } of order) {
      const from = rungOf(placement, id);
      const to = result.placement.get(id);
      if (to === undefined || to === null) continue;
      if (from === null || to < from)
        episode.promoted.set(id, { rung: to, atWidth: budget });
    }
    setPlacement(result.placement);
  }, [
    root,
    trigger,
    panelDock,
    parkingDock,
    placement,
    effective,
    degraded,
    surrender,
    collapsed,
    overflow,
    label,
    measure,
    isRendered,
    layoutMeasured,
    nestedInBar,
    grow.granted,
    grow.relays,
  ]);

  // ONE subscription covering everything that can change a width: the row's own
  // size, the trigger's, and every occupant's — which folds in content change,
  // font load, control-density change, theme change and zoom. Its first callback
  // runs SYNCHRONOUSLY inside the layout effect, which is what gives the cold
  // start no flash: measure, decide and re-commit all happen before paint.
  useResizeObserver(
    () => {
      if (root === null) return null;
      const observed: Element[] = [root];
      if (trigger !== null) observed.push(trigger);
      for (const entry of entriesRef.current.values())
        observed.push(entry.container);
      return observed;
    },
    reconcile,
    { deps: [reconcile, version, editMode] },
  );

  // ── The two contract-free locks ──────────────────────────────────────────
  // React synthetic events bubble the FIBER tree, not the DOM tree, so the bar's
  // own root sees a pointer-down inside a widget that physically lives in the
  // body-portaled panel. That is what makes this work with no author opt-in:
  // the item under the pointer is pinned for the duration of the gesture, and
  // `useHoldShrink` is left to cover only what survives the release.
  const onPointerDownCapture = useCallback(
    (e: ReactPointerEvent): void => {
      const target = e.target as Node | null;
      if (target === null) return;
      for (const entry of entriesRef.current.values()) {
        if (!entry.container.contains(target)) continue;
        entry.pointerPinned = true;
        // A release outside the bar (the pointer left the widget, or capture was
        // never taken) would never reach a React handler here, and a permanently
        // pinned item is worse than a moved one. The document listeners are the
        // fail-safe, and they run once.
        const release = (): void => {
          entry.pointerPinned = false;
          document.removeEventListener("pointerup", release, true);
          document.removeEventListener("pointercancel", release, true);
          bump();
        };
        document.addEventListener("pointerup", release, true);
        document.addEventListener("pointercancel", release, true);
        return;
      }
    },
    [bump],
  );

  /**
   * Said once per mount, and only once the root is attached so the fault can
   * name WHERE the nested bar is written — `origin` is the innermost UI-context
   * node above the bar's root, and it is the field the report is deduped on.
   */
  const nestedReportedRef = useRef(false);
  // "One adaptive bar per row", enforced instead of written down.
  //
  // Not part of `reconcile`, and deliberately so: nesting is a fact about the
  // TREE, not about a width, so it holds from the first commit and needs no
  // measurement to establish. Routing it through the pass would also make it
  // unreachable in exactly the shape it describes — a nested bar's grow ask is
  // swallowed by the rigid container it sits in, so `reconcile` can return at
  // `!grow.granted` and never reach a guard placed below it.
  //
  // The remedy is `no-slack`'s (the ceiling, latched) rather than the floor's,
  // and for the same reason: a bar inside another bar's occupant is inside a
  // `shrink-0` container, so every width it reads is its own content's. An
  // eviction is precisely what a bad width reading was already producing.
  // Committed BEFORE the throw, so the dev crash leaves behind the layout that
  // hides nothing.
  useLayoutEffect(() => {
    if (!nestedInBar || root === null || nestedReportedRef.current) return;
    nestedReportedRef.current = true;
    setDegraded(true);
    failLoudly({
      kind: "nested-bar",
      label,
      overflow,
      ...originOf(root),
      message:
        "this bar is rendered INSIDE another adaptive bar's occupant, and one adaptive bar per row is the primitive's contract. Both bars declare themselves min-w-0 flex-1 and ask the row above for its slack, so the inner one takes all of it and the outer one is left measuring its own content — which the outer bar then reports as no-slack, blaming a host that is fine. The inner bar has stopped deciding: every occupant back in the row, CSS clips. Delete it and render its occupants as ordinary children of the widget, so the OUTER bar's ⋯ collapses them; a bar per row is what makes either bar's width mean anything. (An AdaptiveBar.Collapsed nested in a bar is legitimate and never reaches this: it is one shrink-0 ⋯ that measures nothing.)",
    });
  }, [nestedInBar, root, label, overflow]);

  // Detect the one case a plain re-parent destroys outright, once per item, at
  // the moment we would otherwise move it.
  useLayoutEffect(() => {
    if (supportsStatePreservingMove()) return;
    for (const entry of entriesRef.current.values()) {
      if (entry.immovable || !holdsIframe(entry.container)) continue;
      entry.immovable = true;
      reportFault({
        kind: "iframe-relocation",
        label,
        overflow,
        ...(root === null ? {} : originOf(root)),
        message: `bar item "${entry.id}" contains an <iframe> and this browser has no moveBefore(), so relocating it would reload the frame. It is pinned in the row instead.`,
      });
      bump();
    }
  }, [version, label, bump, root, overflow]);

  const rootClass = collapsed
    ? cn(BAR_COLLAPSED_ROOT, className)
    : cn(
        BAR_ROOT,
        overflow === "scroll" ? BAR_SCROLL : spill ? BAR_SPILL : BAR_CLIP,
        align === "end" && BAR_ALIGN_END,
        className,
      );

  return (
    <BarRegistryContext.Provider value={registry}>
      <BarRegionAttrsContext.Provider value={regionAttrs}>
        <BarFormsContext.Provider value={forms}>
          {/*
          A bar is a single-line strip by contract: a raw string or chip inside
          it must not wrap the row into two lines, and a `<Text>` leaf inside a
          widget must ellipsize rather than grow the row it is being measured
          against.
        */}
          <SingleLineProvider value={true}>
            <Stack
              ref={setRoot}
              direction="row"
              align="center"
              gap={gap}
              className={rootClass}
              // Lets a growing `AdaptiveBar.Yield` see whether the row holds an
              // explicit slack claimant (a reorder spacer) and give the slack up.
              data-adaptive-bar-root=""
              onPointerDownCapture={onPointerDownCapture}
            >
              {/*
              The bar mints one stable container per occupant and re-parents it
              to place it, so THAT container is each item's box. A slot rendering
              its contributions in here must not draw a second one — it would be
              a competing flex item that swallowed the container, and the bar's
              gap, measurement and docking would describe the cell instead of the
              row. Declared here so `.Render` composes inside an `AdaptiveBar`
              the way this primitive's own docstring has always shown it.
            */}
              <SlotItemLayout orientation="host-owned">
                {children}
              </SlotItemLayout>
              <span
                ref={setTrigger}
                data-adaptive-bar-trigger=""
                hidden={!showTrigger}
                // The trigger is a flex item of this row whose width
                // `measureTrigger` CACHES, so one squeezed reading would
                // under-reserve it forever. It says so itself now that the row no
                // longer declares rigidity for its children — see `BAR_ROOT`.
                className={rigidClass()}
              >
                <IconButton
                  icon={moreHorizIcon}
                  label={label}
                  aria-haspopup="dialog"
                  aria-expanded={panelOpen}
                  onClick={() => setPanelOpen((open) => !open)}
                />
              </span>
              {/*
              The parking dock: a live, hidden parent that always exists inside
              the bar. `overflow="clip"` drops occupants here rather than
              detaching them, so a container is never orphaned and a clipped
              widget comes back as the same instance the moment the row is wider.
            */}
              <div hidden ref={setParkingDock} />
            </Stack>
          </SingleLineProvider>
          <OverflowPanel
            open={panelOpen}
            anchor={trigger}
            label={label}
            dockRef={setPanelDock}
            dockAttrs={regionAttrs}
            hasOpenChildPopup={() =>
              [...entriesRef.current.values()].some(
                (entry) =>
                  entry.popupOpen &&
                  panelDock?.contains(entry.container) === true,
              )
            }
            onDismiss={() => setPanelOpen(false)}
          />
        </BarFormsContext.Provider>
      </BarRegionAttrsContext.Provider>
    </BarRegistryContext.Provider>
  );
}

/**
 * The trigger's real width, never a hardcoded constant — a `MORE_BTN_W = 32`
 * is simply wrong at any other control density, and density is ambient.
 *
 * The trigger is `hidden` while nothing is evicted, so the very first fit has
 * nothing to read. Revealing it, measuring, and re-hiding inside one
 * synchronous block costs one forced reflow ONCE per bar (the answer is cached
 * and re-measured by the shared observer whenever the trigger is genuinely
 * visible) and is invisible to both React and the paint.
 */
function measureTrigger(
  trigger: HTMLElement | null,
  measure: (el: Element) => number,
  cache: { current: number | null },
): number {
  if (trigger === null) return cache.current ?? 0;
  if (!trigger.hidden) {
    const px = measure(trigger);
    if (px > 0) cache.current = px;
    return cache.current ?? 0;
  }
  if (cache.current !== null) return cache.current;
  trigger.hidden = false;
  const px = measure(trigger);
  trigger.hidden = true;
  // Same `px > 0` guard as the visible branch, and for a sharper reason: a 0
  // cached HERE is permanent. A hidden element reports no resize, so the shared
  // observer can never repair it, and every later fit would under-reserve the
  // trigger's width and manufacture a row that overflows by exactly one button.
  if (px > 0) cache.current = px;
  return px;
}

/**
 * Does this bar's width follow its own content?
 *
 * The one question the whole primitive rests on, asked of the layout engine
 * directly instead of inferred from a style. Take the reading the pass already
 * has (`withContent`), hide everything the row is currently holding, read the
 * row again, put it back: a bar that was GIVEN its width measures the same
 * either way, and a bar sitting in a box that shrink-wraps to it measures its
 * own content twice.
 *
 * Every cheaper proxy misses the shape that actually ships. `flex-grow: 0` is
 * false here — the bar sets `flex-1` on itself, so the failing case reads as
 * healthy — and `measureRowOverflow` cannot fire either, because a bar whose box
 * grew to fit its own content is not overflowing that box. Both proxies describe
 * the bar's own declaration; only this one describes what the engine did with it.
 *
 * One forced reflow per ask, and invisible to React and to the paint: the
 * mutation is reverted inside the same synchronous block, so the shared
 * `ResizeObserver` compares against sizes that never changed. Same discipline
 * as {@link measureTrigger}, which reveals the hidden trigger to measure it.
 * The caller decides how often to ask — see {@link MAX_SLACK_PROBES}.
 *
 * Goes through the measurement seam rather than `getBoundingClientRect`, so the
 * jsdom suite can model a shrink-wrapping host and drive this exact path —
 * a real fixture, not a mock of the thing under test.
 */
function widthFollowsContent(
  root: HTMLElement,
  inline: readonly HTMLElement[],
  measure: (el: Element) => number,
  withContent: number,
): boolean {
  const wasHidden = inline.map((el) => el.hidden);
  for (const el of inline) el.hidden = true;
  const withoutContent = measure(root);
  inline.forEach((el, i) => {
    el.hidden = wasHidden[i] ?? false;
  });
  // A pixel of tolerance: sub-pixel layout rounding is not content dependence,
  // and the failure this catches is measured in whole occupants.
  return Math.abs(withContent - withoutContent) > 1;
}

/**
 * Every unpinned occupant at its narrowest rung — the one configuration
 * guaranteed not to overflow, and therefore what we commit when we stop
 * believing the search.
 *
 * Only for a fault whose width reading is TRUSTWORTHY and whose fit disagrees
 * with the engine anyway. When the width itself is the lie, the floor is the
 * wrong direction entirely and `degraded` (the ceiling) is the remedy — taking
 * occupants out of the row is precisely what a bad width was already doing.
 *
 * **It is also the last placement this bar computes at this width**, and that
 * is why the surrender is latched HERE rather than by the callers: flooring and
 * stopping are one act, so there is no spelling of "take the floor and keep
 * deciding".
 *
 * That spelling is what took the Layout Lab pane down. A floor commit changes
 * the placement, a changed placement re-runs the measure-and-decide effect, and
 * the fit — deliberately current-state-independent apart from pins and
 * hysteresis — recomputes the same ideal it had before, converges, trips the
 * same guard, and floors again. Neither counter could stop it: the convergence
 * branch and the commit both reset the round counter, so the budget counted a
 * number that was being zeroed underneath it, and React eventually threw
 * "maximum update depth exceeded" over a layout disagreement.
 *
 * Scoped to the WIDTH rather than the mount, and that distinction is load-
 * bearing rather than cautious. `no-convergence` is often transient — a font
 * arriving mid-pass, a late icon — and it is observed on ordinary healthy
 * surfaces; parking such a bar at its floor until the pane is reopened buries
 * every action in the `⋯` panel, which is worse than the fault.
 * {@link MAX_SURRENDERS} bounds the re-arms.
 */
function commitFloor(
  items: readonly FitItem[],
  overflow: AdaptiveBarOverflow,
  setPlacement: (next: Placement) => void,
  surrender: Surrender,
  atWidth: number,
): void {
  surrender.surrendered.current = true;
  surrender.at.current = atWidth;
  surrender.count.current += 1;
  const floor = new Map<string, number | null>();
  for (const item of items) {
    if (item.pinned === true) {
      floor.set(item.id, item.currentRung);
      continue;
    }
    // Evicting is only a remedy where an evicted occupant is still REACHABLE,
    // and that is `panel` alone. `clip` drops its evictions into a hidden
    // parking dock, so flooring a clip bar hides every occupant it holds — a
    // strictly worse outcome than the clipping that mode already accepts, and
    // for a fault whose whole premise is "my width reading is honest".
    const evictable = item.evictable && overflow === "panel";
    floor.set(item.id, evictable ? null : item.inlineWidths.length - 1);
  }
  setPlacement(floor);
}

/**
 * Stop deciding, and commit the best answer this search actually produced.
 *
 * A search that runs out of rounds has usually produced perfectly good answers
 * along the way, and the floor throws all of them away: every occupant at its
 * narrowest rung, everything evictable behind the `⋯`. That is what makes a
 * *transient* fault cost the user their whole toolbar, and the fault is
 * transient often enough to be worth this.
 *
 * The floor's one virtue is that it cannot overflow. A placement the fit blessed
 * as `fits` from measurements alone (never estimates, which can refuse a fit but
 * never fabricate one) carries the same claim, by the same arithmetic, and is
 * strictly wider — so it is preferred whenever the search produced one AT THIS
 * WIDTH. The width test is not decoration: a placement that fitted 900px says
 * nothing about 400px.
 *
 * Latching lives HERE, in both branches, and that is the load-bearing part.
 * Committing and stopping are one act, so there is no spelling of "take the
 * fallback and keep deciding" — which is precisely what took the Layout Lab pane
 * down: a commit changes the placement, a changed placement re-runs the
 * measure-and-decide effect, the fit recomputes the same answer, trips the same
 * guard, and commits again, forever.
 *
 * Scoped to the WIDTH rather than the mount, bounded by {@link MAX_SURRENDERS}:
 * a genuine resize is a premise this bar has not failed under, and refusing to
 * re-derive there would park a toolbar for the life of the pane.
 *
 * Returns the sentence describing what it did, for the fault message — so the
 * remedy cannot be described by a caller that does not know which branch ran.
 */
function commitSurrender(
  items: readonly FitItem[],
  best: { placement: Placement; available: number } | null,
  overflow: AdaptiveBarOverflow,
  setPlacement: (next: Placement) => void,
  surrender: Surrender,
  atWidth: number,
): string {
  if (best !== null && Math.abs(best.available - atWidth) <= WIDTH_EPSILON_PX) {
    surrender.surrendered.current = true;
    surrender.at.current = atWidth;
    surrender.count.current += 1;
    setPlacement(best.placement);
    return "Committed the widest placement this search measured as fitting, rather than throwing the whole search away.";
  }
  commitFloor(items, overflow, setPlacement, surrender, atWidth);
  return overflow === "panel"
    ? "The search never produced a placement it could vouch for at this width, so the bar took the floor: every unpinned occupant at its narrowest rung, everything else in the overflow panel."
    : "The search never produced a placement it could vouch for at this width, so the bar took the floor: every unpinned occupant at its narrowest rung, all of them still in the row.";
}

/**
 * Start counting again: these rounds were not part of the search that is about
 * to run.
 *
 * Called from the two places an episode genuinely ends — a converged pass, and
 * a surrender re-armed by a real resize. Takes the whole {@link Episode} for the
 * same reason {@link Surrender} is bundled: a caller able to reset the counter
 * but not the evidence would file a fault describing a different episode, and a
 * caller able to reset `total` would give back the termination bound.
 *
 * `premise` is deliberately NOT cleared. It describes the row as it currently
 * is, not the search — so the first round of the next episode can still say
 * whether a width moved underneath it.
 */
function startEpisode(episode: Episode): void {
  episode.rounds = 0;
  episode.total = 0;
  episode.shifts = 0;
  episode.trace.length = 0;
  episode.moved.clear();
  episode.best = null;
  // The promotion record goes too: it is H2's evidence about the search that
  // has just finished, and the next one has not promoted anything yet.
  episode.promoted.clear();
}

/** A placement as one comparable string — for spotting a repeat, not for equality. */
function placementKey(placement: ReadonlyMap<string, number | null>): string {
  return [...placement]
    .map(([id, rung]) => `${id}:${rung === null ? "-" : String(rung)}`)
    .sort()
    .join(",");
}

/**
 * Where this bar is written.
 *
 * A generic primitive has no name of its own, and the one its consumer gave it
 * (`label`) is not an identity: it defaults to `"More"`, and two unrelated bars
 * on one route take that default today. The DOM already holds the answer — the
 * innermost UI-context node above the bar's root, which resolves to
 * `apps-core.tab-bar@apps.tab-bar` for the app tab strip and
 * `conversations.conversation-view.prompt-templates@prompt-editor.floating-action`
 * for the pinned prompt-template chips. Measured on the live app, not assumed.
 *
 * Deliberately NOT `nearestSource` (the build-stamped `<file>:<line>` the
 * element picker uses), even though it reads like the better name: the nearest
 * stamped element above a bar root is the picker's own marker span, or a
 * primitive the consumer composed — never the consumer. It would have been the
 * same constant for every bar in the app.
 *
 * The full lineage path is carried separately and never fingerprinted: it embeds
 * per-instance region ids, so two conversation panes would split one finding in
 * two — the mirror of the collision this exists to fix.
 *
 * On the fault path only. The walk climbs ancestors and portal chains, which is
 * far too much to pay per pass and exactly nothing to pay per fault.
 */
function originOf(root: HTMLElement): { origin?: string; originPath?: string } {
  const nodes = collectLineage(root);
  const innermost = nodes[nodes.length - 1];
  const path = formatLineagePath(nodes);
  // A contribution node is already an id-free name (`plugin@slot`), and
  // `formatLineageNode` is where that spelling lives — re-spelling it here is
  // how two consumers of one grammar drift. A region node is NOT usable as it
  // stands: its spelling carries the per-instance pane/tab id, so it is reduced
  // to the parts that are the same on every mount.
  const origin =
    innermost === undefined
      ? undefined
      : innermost.kind === "contribution"
        ? formatLineageNode(innermost)
        : `${innermost.pluginId ?? ""}#${innermost.regionKind}`;
  return { origin, originPath: path === "" ? undefined : path };
}

function samePlacement(a: Placement, b: Placement): boolean {
  if (a.size !== b.size) return false;
  for (const [id, rung] of a) {
    if (!b.has(id) || b.get(id) !== rung) return false;
  }
  return true;
}

/** A px length off a computed style, where "not a length" means zero. */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * By how much does the rendered row stick out of the box the bar was given?
 *
 * The second half of the grow-cell contract. `widthFollowsContent` catches "the
 * width I read is not a width I was given" once, at mount; this catches the
 * case where the width is honest and the fit's own numbers are not — per pass,
 * against the rendered result rather than an assumption.
 *
 * **The occupants against the bar's own content box — never an ancestor.**
 * This question used to be put to `root.offsetParent`, which is the nearest
 * *positioned* ancestor: a different thing from "the row I am a cell of", and
 * one that can be anywhere on the page. A bar inside a horizontally scrolled
 * strip sits hundreds of pixels to its right in viewport space while fitting
 * its own row perfectly, and was accused on every pass — which is what killed
 * the Layout Lab (now Debug → Exhibits), where every exhibit card has exactly
 * that shape. Do not reintroduce an ancestor comparison in any form;
 * `parentElement` is no better,
 * since the parent may shrink or carry padding of its own.
 *
 * **And not `root.scrollWidth > root.clientWidth` either**, tempting as the
 * one-liner is. LTR scrollable overflow ignores content past the *left* edge,
 * and `align="end"` packs the occupants against the far edge — so a pane header
 * (every one of which is `align="end"`) overflowing by 16px reads
 * `scrollWidth === clientWidth`. Measured, not assumed. It also folds in
 * *descendants'* overflow, so a widget's own `active:scale` transform or an
 * absolutely-positioned badge would inflate it into a false accusation, and a
 * false accusation costs the whole pane.
 *
 * Reading the occupant containers instead is exact on both counts: each rect is
 * that container's own border box, so nothing a widget paints inside itself
 * leaks into the answer, and the union covers both directions.
 */
function measureRowOverflow(
  root: HTMLElement,
  order: readonly { anchor: HTMLElement; entry: BarItemEntry }[],
  trigger: HTMLElement | null,
): number {
  const rect = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const box = {
    left: rect.left + px(style.paddingLeft) + px(style.borderLeftWidth),
    right: rect.right - px(style.paddingRight) - px(style.borderRightWidth),
  };

  const spans: Span[] = [];
  const addIfLaidOut = (el: HTMLElement): void => {
    // Load-bearing: an element generating NO boxes (`hidden`, which is how
    // absence and the un-needed `⋯` are both spelled) reports a rect of all
    // zeros — at the viewport origin, which would fabricate a full-width LEFT
    // overflow on every bar. The layout harness documents the same trap for
    // `display: none` slots.
    if (el.getClientRects().length === 0) return;
    const r = el.getBoundingClientRect();
    spans.push({ left: r.left, right: r.right });
  };
  // The other filter, and it is per-KIND because "still in the row" is asked
  // differently of the two. An occupant is in the row when it is docked at its
  // own anchor, however deep the host put that anchor; one that is not has been
  // relocated into the body-portaled panel, so its rect describes the panel's
  // layout and says nothing about this row. The `⋯` trigger is the bar's own
  // element and IS a direct child, so for it the parent check is exact.
  for (const { anchor, entry } of order) {
    if (!isDockedInline(entry.container, anchor)) continue;
    addIfLaidOut(entry.container);
  }
  if (trigger !== null && trigger.parentNode === root) addIfLaidOut(trigger);

  return overflowPx(box, spans);
}
