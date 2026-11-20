import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import type { ConvergenceEvidence } from "@plugins/primitives/plugins/adaptive-bar/core";
// Type-only, and therefore not a runtime cycle: the fault body names the bar's
// overflow mode, and the mode is declared where the props that carry it are.
import type { AdaptiveBarOverflow } from "./adaptive-bar";

/**
 * The ways an adaptive bar is *wrong*, as opposed to merely cramped.
 *
 * Running out of room is the normal case and is never a fault — it is what the
 * whole primitive is for. These six are the states where an assumption has been
 * violated, and living with them silently is how a layout bug becomes permanent.
 */
export type AdaptiveBarFaultKind =
  /** The bar was not given slack: some ancestor is shrink-to-content, or a sibling took the grow slot. */
  | "no-slack"
  /**
   * A MEASURING bar was mounted inside another bar's occupant.
   *
   * "One adaptive bar per row" used to be prose, and prose is the weakest way to
   * state a rule this cheap to check: a bar reads `BarRegistryContext` and
   * a non-null one means a bar is already above it. Two measuring bars in one
   * row cannot both be right — each declares itself `min-w-0 flex-1` and asks
   * the chain above it to grow, so the inner one takes the row's whole slack and
   * the outer one is left measuring its own content. The outer bar then reports
   * `no-slack` and stops deciding, which is a true statement about a defect
   * somewhere else entirely — this kind names the actual offender.
   *
   * `AdaptiveBar.Collapsed` nested in a bar is NOT this and must never fire it:
   * it is one `shrink-0` `⋯` sitting among the row's occupants, it takes no
   * slack, it measures nothing, and it is how `reorder`'s `overflow` node type
   * renders an authored bucket inside a pane header — a legitimate composition
   * that ships today. Only a bar that MEASURES is a second claimant.
   */
  | "nested-bar"
  /** The fit said "everything fits" and the rendered row still overflows the box the bar was given. */
  | "row-overflow"
  /** The round budget ran out and the answer was still changing. */
  | "no-convergence"
  /** A container holds an `<iframe>` and this browser has no `moveBefore`, so relocating it would reload it. */
  | "iframe-relocation"
  /**
   * A widget declared a smaller form and then rendered NOTHING as it.
   *
   * The one fault about the *contributor* rather than the host or the browser:
   * `useActionForm({ shrinksTo: ["compact"] })` is a promise to render something
   * as compact, and vanishing is the one transformation this primitive exists to
   * prevent. The bar recovers on its own — it stops offering that form and the
   * widget leaves the row instead — which is exactly why it has to say so, or
   * the widget silently loses a form nobody knows it lost.
   *
   * Rung 0 is not this: a contribution that renders nothing at all is ordinary,
   * supported, and reported nowhere.
   */
  | "empty-rung";

export interface AdaptiveBarFault {
  kind: AdaptiveBarFaultKind;
  /** The bar's accessible label — the name its own consumer gave it. */
  label: string;
  /**
   * Which composition this bar belongs to.
   *
   * The label alone is not an identity. It defaults to `"More"`, and two
   * unrelated bars on one route take that default today (the app tab strip and
   * the pinned prompt-template chips), so a fault fingerprinted on the label
   * collapses them onto one row and hides the second behind the first's count.
   *
   * Read from the DOM at fault time as the innermost UI-context node above the
   * bar's root — `apps-core.tab-bar@apps.tab-bar` for one of those two,
   * `conversations.conversation-view.prompt-templates@prompt-editor.floating-action`
   * for the other. Absent where nothing carries lineage: a fixture, a story, a
   * bare test render.
   */
  origin?: string;
  /** The full lineage path, for the reader who needs more than one name. */
  originPath?: string;
  /**
   * The bar's overflow mode.
   *
   * Carried, and fingerprinted, because it is the one discriminator that costs
   * nothing and already separates today's two colliding `"More"` bars — the tab
   * strip is `scroll`, the prompt-template chips are `clip`. It also decides
   * what a fault's remedy is allowed to do, so a reader needs it.
   */
  overflow?: AdaptiveBarOverflow;
  message: string;
  /**
   * Which occupant a fault is about, where it is about one.
   *
   * `empty-rung` is the only kind whose subject is a specific CONTRIBUTOR rather
   * than the bar's host, and the id is the field a reader filters on, so it is a
   * typed field and not only a phrase inside {@link AdaptiveBarFault.message}.
   * Fingerprinted, because one bar holding three vanishing widgets is three
   * findings with three different owners, not one row with a count of three.
   */
  item?: { id: string; rung: number; form: string };
  /**
   * What the bar established about a `no-convergence`, so nobody has to
   * reproduce a transient. Absent for the other kinds, which have no rounds.
   */
  evidence?: ConvergenceEvidence;
}

/**
 * Where a fault goes in production. `reports/adaptive-bar` registers the mapping
 * to a filed report; with nothing registered, `emit` only holds a bounded backlog — which is
 * correct for a primitive that must stay usable in a test harness, a fixture
 * page and a standalone story, and is exactly why the app composition MUST
 * carry a collector. It did not, so every fault below was silently dropped in
 * prod until the Layout Lab pane started dying of one.
 */
export const adaptiveBarReportSink = defineReportSink<AdaptiveBarFault>(
  "primitives/plugins/adaptive-bar:adaptiveBarReportSink",
);

/**
 * Report and keep going. For a fault the bar has already handled correctly:
 * refusing to relocate an iframe, or declining to offer a form a widget does not
 * render. Both are the right behaviour rather than a bug to take a pane down
 * over — and `empty-rung` in particular must never throw in dev, because a
 * widget that renders nothing for one frame while its data loads would take the
 * pane with it.
 */
export function reportFault(fault: AdaptiveBarFault): void {
  adaptiveBarReportSink.emit(fault);
}

/**
 * Report, then throw in dev.
 *
 * For the faults that mean the bar's own contract is broken — it was given no
 * slack, it was written inside another bar, or its fit math disagrees with the
 * layout engine. Those must not be
 * lived with: in dev the throw is the fastest possible feedback, and in prod we
 * file the alert and take a cramped-but-usable layout instead, because taking
 * down a pane header over a layout disagreement is worse than a cramped row
 * plus a report.
 *
 * The caller commits that layout BEFORE calling this, so the two orders are not
 * interchangeable: throwing first would leave the row in the state that was
 * already known to be wrong. Committing it also SURRENDERS the bar (see
 * `commitSurrender`) — without that, "file and keep going" was a render loop,
 * and the prod outcome was the dead pane the throw was meant to avoid.
 */
export function failLoudly(fault: AdaptiveBarFault): void {
  reportFault(fault);
  if (import.meta.env.DEV) {
    throw new Error(`adaptive-bar (${fault.label}): ${fault.message}`);
  }
}

/**
 * How far apart two widths have to be before they are different widths.
 *
 * Rects are fractional, and a fraction of a pixel is layout rounding rather
 * than a widget resizing itself or a row being given more room. Without this
 * tolerance every round on a real page reads as a changed premise — the same
 * mistake as counting a changed premise as a failed round, inverted.
 *
 * Must stay strictly below {@link HYSTERESIS_PX}, which is the width change a
 * surrendered bar needs before it re-arms. If the two ever crossed, a width
 * could be "a new premise, start counting again" and "not a resize, stay
 * surrendered" at the same time.
 */
export const WIDTH_EPSILON_PX = 0.5;

/**
 * How many rounds of evidence a fault carries.
 *
 * Enough to show a cycle (which needs a repeat) and the widths either side of a
 * move; not a log. The ring is kept for every bar on every pass, so it is
 * numbers only and it is short.
 */
export const TRACE_ROUNDS = 6;

/**
 * How many times the premise may move without the bar ever reaching a settled
 * answer.
 *
 * Tolerating a moving premise — a font landing, a late icon, a ladder arriving
 * on a passive effect one round after the item it belongs to — is the whole
 * point of scoping the round counter to it. But a bar whose widths never stop
 * moving is a real pathology, distinct from a search that will not settle, and
 * it deserves to be said in those words rather than blamed on the fit.
 */
export const MAX_PREMISE_SHIFTS = 6;

/**
 * The round counter nothing resets, and the reason a resettable one is safe.
 *
 * `reconcile` re-enters itself **synchronously** through its layout effect
 * after every commit — there is no frame boundary anywhere in the chain — so a
 * bar whose occupants resize themselves on each of those commits would reset
 * the per-premise counter forever. Not hypothetically: `:hover` is recomputed
 * when a container is re-parented out from under the pointer, and a widget with
 * its own measuring layout effect re-measures whenever its parent re-renders.
 * Neither is expressible as "the search failed"; both are unbounded without
 * this.
 *
 * Well under React's own nested-update limit (50), because every round costs at
 * least one nested synchronous update and some cost more. That margin is the
 * difference between a warning in Debug → Reports and a dead pane.
 */
export const HARD_ROUND_CEILING = 20;

/**
 * How many times one bar may give up and try again before it stays given up.
 *
 * A fault commits the floor and stops the bar deciding — otherwise the floor
 * re-runs the pass, the fit recomputes the same answer, and the same fault
 * fires forever (React's "maximum update depth exceeded", a dead pane).
 *
 * But "stopped" must be scoped to the width it happened at, not to the mount.
 * `no-convergence` is frequently a TRANSIENT — a font arriving mid-pass, a
 * late icon, a widget re-rendering between measure and decide — and it is
 * observed on ordinary healthy surfaces, not just broken ones. Parking such a
 * bar at its floor forever means every action sits in the `⋯` panel until the
 * user reopens the pane, which is a worse outcome than the fault.
 *
 * So the bar re-arms when its own width genuinely changes (the premise it
 * failed under is gone), and this caps how often. The re-arm cannot feed
 * itself: the bar is the grow cell, so its width comes from its row and not
 * from its own content, and committing the floor therefore cannot change the
 * number that would re-arm it. The cap is the backstop for the one shape where
 * that reasoning fails — a shrink-to-content ancestor, which is `no-slack`'s
 * business — so termination never rests on the argument alone.
 */
export const MAX_SURRENDERS = 3;

/**
 * How many times one bar may ask the layout engine whether its width follows
 * its own content.
 *
 * The probe hides the row's occupants, re-reads the row and puts them back, so
 * it costs a forced reflow — and the premise it verifies belongs to the HOST,
 * which can change after the bar mounts: a framing variant swaps, a wrapper's
 * class flips, contributions arrive in a later plugin wave, or a shrink-to-
 * content ancestor whose width was floored by a wider sibling stops being
 * floored once the bar's own content grows past it. Asking once at mount spends
 * the guard before any of that happens.
 *
 * So it is re-asked when the row NARROWS, which is the ratchet's own direction:
 * an eviction can only ever reduce what the row holds, so a content-following
 * row can only be dragged narrower by the bar's own decisions, and a masked
 * shrink-wrap reveals itself on the first eviction that takes the content below
 * its floor. A widening pane costs nothing.
 *
 * The budget is what keeps that from being one forced reflow per frame of a
 * narrowing drag. Six rather than two or three, because a legitimate width
 * SWEEP spends one on every step: the layout-geometry gate renders one bar
 * across a range of widths, and any surface that steps through several widths
 * in quick succession does the same — a budget tuned for "one or two host
 * changes" is gone before a later onset could ever be observed. Six is the
 * mount verification plus enough re-verifications to survive such a sweep, and
 * still a handful of reflows rather than one per frame of a sustained drag.
 * The trade, stated rather than hidden — after a long drag the bar is back to
 * trusting its last verification, which is exactly today's behaviour and
 * strictly better than it. Soundness is untouched either way: the probe is
 * definitive, so the schedule changes only WHEN a true answer is obtained,
 * never whether the answer is true.
 */
export const MAX_SLACK_PROBES = 6;

/**
 * How many times one bar may re-admit its occupants to re-ask a zero width,
 * before it stops asking and takes the ceiling for good.
 *
 * A RENDERED row that measures nothing with occupants parked outside it can mean
 * two different things, and the width alone cannot tell them apart. Either the
 * ratchet has reached its end — the host shrink-wraps to the bar, so every
 * eviction shrank the width that decided the next one, and the row has emptied
 * itself — or the row is merely OVER-FULL: `flex-1` is `flex: 1 1 0%`, so when
 * the row's other items over-fill their container, free space is negative and
 * the bar's cell resolves to exactly 0px while fully laid out. Nothing is wrong
 * with the host there; the bar simply has no room at this width.
 *
 * The differential probe ({@link MAX_SLACK_PROBES}) is the guard that CAN tell
 * them apart, and it is correctly silent in the second case — hiding the
 * occupants cannot change a width that comes from negative free space. But it
 * needs occupants in the row to hide, which is exactly what the first case has
 * run out of. So the bar re-admits everything and re-asks, instead of guessing
 * from a number that carries no answer.
 *
 * **This is not what makes the recovery terminate**, and believing it is would
 * be the way to break it. A recovery's follow-up pass runs at a real width and
 * commits a different placement, so it costs one `episode.total` like any other
 * — which means {@link HARD_ROUND_CEILING} already bounds a recovery loop, and
 * already ends it with a `no-convergence` surrender. What this number decides is
 * the **diagnosis**: whether a bar that cannot get an answer says `no-slack`
 * (true — the width reading is the problem) or `no-convergence` (a
 * misdiagnosis, blaming the fit for a host's arithmetic).
 *
 * So it is cleared at exactly the instant `episode.total` is — a pass that
 * converges without faulting — rather than on any looser signal. Tying the two
 * together means this introduces no new termination claim: it inherits one that
 * is already proven and already tested (`web/__tests__/termination.test.tsx`).
 * A monotonic per-mount cap was the obvious alternative and is wrong: a single
 * drag oscillating around the collapse point burns one per crossing, so it
 * reinstates the permanent latch, conditioned on gesture history.
 *
 * Three, and the ceiling is React's margin rather than a UX budget. Each
 * recovery costs about two nested synchronous updates on top of an episode
 * already allowed to run to {@link HARD_ROUND_CEILING}, which is itself chosen
 * to stay well under React's nested-update limit of 50. One recovery is all a
 * healthy answer needs; the other two are the spare for an occupant that mounts
 * mid-chain.
 */
export const MAX_ZERO_RECOVERIES = 3;

/**
 * The promote band, in px — one `gap-sm`. A demotion is accepted the moment the
 * row overflows; a promotion needs this much headroom on top. The two
 * predicates are disjoint, so no single width both demands a demote and permits
 * the matching promote, which is what stops a one-pixel resize from flickering
 * the row back and forth.
 */
export const HYSTERESIS_PX = 8;
