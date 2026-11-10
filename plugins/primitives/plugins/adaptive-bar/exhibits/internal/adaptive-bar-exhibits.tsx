import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { afterLayout } from "@plugins/primitives/plugins/dom/plugins/after-layout/web";
import { HOST_MARKER_ATTR } from "@plugins/primitives/plugins/css/plugins/layout-harness/plugins/geometry/core";
import {
  isolatedExhibit,
  type Exhibit,
} from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  useActionForm,
  useHoldShrink,
} from "@plugins/primitives/plugins/action-presentation/web";
import {
  AdaptiveBar,
  type AdaptiveBarAlign,
} from "@plugins/primitives/plugins/adaptive-bar/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const searchIcon = symbol("search");
const settingsIcon = symbol("settings");
const shareIcon = symbol("share");
const volumeUpIcon = symbol("volume-up");

/**
 * The proof surface.
 *
 * Every surface this primitive can reach in its first pass — pane headers, the
 * authored reorder bucket, the tab strip — is made of plain actions, so none of
 * them exercises the premise: *a draggable widget relocates and is still
 * draggable*. The layout harness does, and it is a genuinely good fit rather
 * than a workaround: it renders real components with real Tailwind, sweeps each
 * fixture across a range of container widths in a real headless Chromium, and
 * judges the measured `[data-geo]` boxes through a generic oracle that never
 * names a primitive's internals.
 *
 * What the sweep proves here: at every width, no two occupants overlap and
 * nothing — including the `⋯` trigger — spills past the row it was given. The
 * bar is the grow cell of a full-width line, so its right edge IS the
 * container's: "nothing clips the container" and "the bar never overshoots its
 * parent" are the same assertion measured once.
 *
 * What the sweep can NOT prove is that the relocated slider still drags, or
 * that it is the same instance afterwards — geometry has nothing to say about
 * either. That is `e2e/adaptive-bar-relocate.ts`, driving this same fixture in
 * the Debug Exhibits gallery.
 */

/**
 * A jog wheel: a real pointer-drag control with no smaller form of itself.
 *
 * The whole point of the fixture. A ribbed drag face at 40px is not a control,
 * so it declares NO rungs — meaning the bar may leave it alone or relocate it
 * as itself, and can never turn it into a labelled row. It holds its
 * assignment while a drag is in flight, and mints an identity once per mount so
 * the e2e can prove the instance survived the round trip.
 */
let wheelMounts = 0;

function JogWheel(): ReactElement {
  const [instanceId] = useState(
    () => `jog-wheel-${String((wheelMounts += 1))}`,
  );
  const [value, setValue] = useState(40);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // One rung: stay full, or relocate as myself. Eager, so the sweep reaches the
  // interesting state (a rich widget in the panel) before it runs out of width.
  useActionForm({ yields: "early" });
  // The bar pins the item under an active pointer by itself; this covers what
  // survives the release, which for a real jog wheel is the inertial coast.
  useHoldShrink(dragging);

  function valueAt(clientX: number): number {
    const track = trackRef.current;
    if (track === null) return value;
    const box = track.getBoundingClientRect();
    if (box.width === 0) return value;
    const ratio = (clientX - box.left) / box.width;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  }

  return (
    <Stack direction="row" gap="2xs" align="center" data-geo="wheel">
      <Text variant="caption" tone="muted">
        Jog
      </Text>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Jog"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        data-instance-id={instanceId}
        className="h-4 w-28 rounded-full bg-muted"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          setValue(valueAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging) setValue(valueAt(e.clientX));
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") setValue((v) => Math.min(100, v + 5));
          if (e.key === "ArrowLeft") setValue((v) => Math.max(0, v - 5));
        }}
      >
        <div
          className="h-4 rounded-full bg-primary"
          style={{ width: `${String(value)}%` }}
        />
      </div>
      <Text variant="caption" tone="muted" data-testid="jog-readout">
        {String(value)}
      </Text>
    </Stack>
  );
}

/**
 * A widget with a genuine smaller form of itself: a labelled slider at full, an
 * icon button at compact. It is what makes the sweep exercise the LADDER rather
 * than just the eviction — at a middle width the row keeps it and shrinks it,
 * and only past that does it leave.
 */
function VolumeControl(): ReactElement {
  const form = useActionForm({ shrinksTo: ["compact"] });
  const [value, setValue] = useState(70);

  if (form === "compact") {
    return (
      <span data-geo="volume">
        <IconButton
          icon={volumeUpIcon}
          label="Volume"
          onClick={() => setValue((v) => (v === 0 ? 70 : 0))}
        />
      </span>
    );
  }
  return (
    <Stack direction="row" gap="2xs" align="center" data-geo="volume">
      <Icon icon={volumeUpIcon} className="icon-auto" />
      <div className="h-4 w-24 rounded-full bg-muted">
        <div
          className="h-4 rounded-full bg-primary"
          style={{ width: `${String(value)}%` }}
        />
      </div>
    </Stack>
  );
}

/**
 * Stamps the harness's `data-geo` vocabulary onto the bar's own trigger.
 *
 * The primitive must not know the harness exists, and the harness measures
 * `[data-geo]` — so the fixture bridges the two, over the trigger's own stable
 * marker attribute. That is what puts "the `⋯` never spills the row" under the
 * same `noClip` invariant as the occupants, instead of leaving it to eyeball.
 */
function useTriggerGeoSlot(): (el: HTMLElement | null) => void {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (host === null) return;
    host
      .querySelector("[data-adaptive-bar-trigger]")
      ?.setAttribute("data-geo", "trigger");
  }, [host]);
  return setHost;
}

/**
 * An occupant the layout engine WOULD squeeze, if the bar let it — and the only
 * one in the catalog that can be, which is worth understanding before writing
 * another.
 *
 * An item container is a flex item of the row with `min-width: auto`, so its
 * floor is its own **min-content**. Every other occupant here reaches that floor
 * at its natural width: the row is `whitespace-nowrap`, a text run that cannot
 * break has a min-content equal to its max-content, and `Button` is `shrink-0`
 * outright. `min-w-0` inside a widget does not change this — it lets the LEAF be
 * smaller, not the box the bar measures.
 *
 * What does: **content that can reflow narrower**. This chip opts back into
 * wrapping, so its min-content is its longest word and the engine can take most
 * of its width. A widget rendering a short sentence is the realistic version;
 * a percentage-sized image is another. Neither is exotic, and neither is
 * expressible as a rung — which is the point: the bar's ladder is the only
 * shrinking an occupant should ever do.
 *
 * Declares no ladder on purpose: one rung, so the width the harness measures
 * cannot change for any legitimate reason. Anything that moves it is the engine
 * taking width from the occupant.
 */
function LabelledChip({ label }: { label: string }): ReactElement {
  return (
    // `whitespace-normal` overrides the row's own `nowrap`, which is what gives
    // this box a min-content below its natural width. Not a style choice — it is
    // the entire mechanism under test.
    <div className="whitespace-normal rounded-md border px-xs py-2xs">
      {label}
    </div>
  );
}

/**
 * Stamps the harness's `data-geo` vocabulary onto the bar's own OCCUPANT
 * containers, over their stable marker attribute.
 *
 * The box that has to be proven rigid is the container the bar measures and
 * writes into the ledger — not the widget inside it, which is a block child of
 * that container and would be dragged along by a squeeze without being the
 * number under test. The primitive must not know the harness exists, so the
 * fixture bridges the two, exactly as {@link useTriggerGeoSlot} does for the
 * `⋯`.
 *
 * No dependency array: an occupant relocated into the body-portaled panel and
 * back is not in this subtree in between, and re-stamping every render is both
 * cheaper and more obviously correct than tracking that.
 */
function useOccupantGeoSlots(
  ids: readonly string[],
): (el: HTMLElement | null) => void {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // After layout, not in the layout effect itself: the bar docks its
  // containers in its own after-layout pass (`dom/after-layout`), so at commit
  // time a container may not be in the row yet. Queued from this effect —
  // which runs after the bar's, the fixture being its parent — the stamp runs
  // after the bar's dock in the same batch.
  useLayoutEffect(() => {
    if (host === null) return;
    return afterLayout(() => {
      host
        .querySelector("[data-adaptive-bar-trigger]")
        ?.setAttribute("data-geo", "trigger");
      for (const id of ids) {
        host
          .querySelector(`[data-adaptive-bar-item="${id}"]`)
          ?.setAttribute("data-geo", id);
      }
    });
  });
  return setHost;
}

const SQUEEZABLE_IDS = ["alpha", "beta", "gamma", "delta"] as const;

/**
 * The width ledger's axiom, as geometry: **an occupant's width is a property of
 * that occupant, not of how many neighbours it has.**
 *
 * Four single-rung occupants, each holding a truncating leaf, in an ordinary
 * `panel` bar swept from roomy to cramped. At the wide end all four are in the
 * row; at the narrow end the fit relocates some of them behind the `⋯`. What
 * must never happen is the third thing: an occupant that STAYS in the row and
 * gets narrower, which is the engine deciding an occupant's width from the
 * placement and the bar then storing that number as if it were the item's own.
 *
 * `rigidIntegrity` is exactly that assertion — it compares a slot's width
 * across the widths where the slot is present and ignores the ones where it is
 * absent, so eviction is tolerated and a squeeze is not.
 */
function SqueezableBarFixture(): ReactElement {
  const hostRef = useOccupantGeoSlots(SQUEEZABLE_IDS);
  return (
    <Line ref={hostRef} className="w-full">
      <AdaptiveBar gap="xs" label="More labels">
        {SQUEEZABLE_IDS.map((id) => (
          <AdaptiveBar.Item key={id} id={id}>
            <LabelledChip label={`${id} toolbar section`} />
          </AdaptiveBar.Item>
        ))}
      </AdaptiveBar>
    </Line>
  );
}

function RichBarFixture(): ReactElement {
  const hostRef = useTriggerGeoSlot();
  return (
    // The e2e handle. The gallery renders this fixture once per swept width, so
    // the script picks one card, resizes THAT card, and watches one bar's
    // occupants move — which is the only way to ask whether an instance
    // survived, since five side-by-side widths are five different instances.
    <Line ref={hostRef} className="w-full" data-testid="adaptive-bar-rich">
      <AdaptiveBar gap="xs" label="More controls">
        <AdaptiveBar.Item id="search">
          <IconButton icon={searchIcon} label="Search" onClick={() => {}} />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="share">
          <IconButton icon={shareIcon} label="Share" onClick={() => {}} />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="settings">
          <IconButton icon={settingsIcon} label="Settings" onClick={() => {}} />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="volume">
          <VolumeControl />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="jog">
          <JogWheel />
        </AdaptiveBar.Item>
      </AdaptiveBar>
    </Line>
  );
}

function ActionsBarFixture(): ReactElement {
  const hostRef = useTriggerGeoSlot();
  return (
    <Line ref={hostRef} className="w-full">
      <AdaptiveBar gap="xs" label="More actions">
        <AdaptiveBar.Item id="search">
          <span data-geo="search">
            <IconButton icon={searchIcon} label="Search" onClick={() => {}} />
          </span>
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="share">
          <span data-geo="share">
            <IconButton icon={shareIcon} label="Share" onClick={() => {}} />
          </span>
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="settings">
          <span data-geo="settings">
            <IconButton
              icon={settingsIcon}
              label="Settings"
              onClick={() => {}}
            />
          </span>
        </AdaptiveBar.Item>
      </AdaptiveBar>
    </Line>
  );
}

/**
 * How far right of the harness's own box the bar is pushed, and how wide the
 * box it actually has to fit in is. Both are authored rather than swept: the
 * point of these two fixtures is that the bar's own row is comfortable while
 * its position on the page is nowhere near the ancestor a naive guard picks.
 *
 * 1200px is not a magic number so much as "wider than any swept width", so the
 * bar's viewport rect starts past the right edge of the harness wrapper at
 * every width in the sweep.
 */
const STRIP_SPACER_PX = 1200;
const STRIP_CARD_PX = 360;

/**
 * The Exhibits gallery's own shape, reduced to one card.
 *
 * A bar that fits its row perfectly, parked far to the right of the nearest
 * *positioned* ancestor. The Lab produces this by construction — it renders
 * every fixture once per swept width as a fixed-width card inside a
 * horizontally scrolling strip, so every card after the first sits hundreds of
 * pixels right of the pane box — and it is the shape that killed the pane: the
 * guard used to compare the bar against `root.offsetParent`, the nearest
 * POSITIONED ancestor, which is a different thing from "the row I am a cell
 * of". Here that ancestor is the harness's own `position: relative` width
 * wrapper, hundreds of pixels to the left. Every pass was accused, every
 * accusation floored the bar, flooring re-decided, and React threw "maximum
 * update depth exceeded".
 *
 * Three structural details, each of which the fixture stops reproducing
 * anything without:
 *
 * - **The strip is authored exactly as wide as its two children**, so the flex
 *   row has no free space to distribute and no deficit to recover. The spacer
 *   IS the offset; a spacer that collapsed under flex shrinking would quietly
 *   delete the premise.
 * - **The card holding the bar is a plain `<div>`, never `position: relative`.**
 *   A positioned card would become the `offsetParent` itself and the old
 *   predicate would answer correctly — the fixture would pass either way and
 *   prove nothing.
 * - **The card carries its own `data-geo="container"`, and the spacer carries
 *   no `data-geo` at all.** `__measure` prefers the INNERMOST container, so
 *   `noClip`/`noOverlap` are judged against the card the bar actually lives in
 *   rather than against the harness wrapper the strip legitimately overruns —
 *   which would otherwise fail for an honest reason that has nothing to do
 *   with the bar.
 *
 * `align` is the whole difference between the two fixtures below; see them for
 * why the `"end"` direction is not redundant.
 */
function StripBarFixture({ align }: { align: AdaptiveBarAlign }): ReactElement {
  const hostRef = useTriggerGeoSlot();
  return (
    <Scroll axis="x">
      {/* Sized to the sum of its children so the flex row has zero free space
          to distribute and zero deficit to recover — no shrinking, either way. */}
      <div style={{ width: STRIP_SPACER_PX + STRIP_CARD_PX }}>
        <Stack direction="row" gap="none" align="center">
          {/* No `data-geo`: the spacer is scenery, not a measured participant. */}
          <div style={{ width: STRIP_SPACER_PX }}>
            <Text variant="caption" tone="muted">
              spacer — the bar starts {STRIP_SPACER_PX}px right of the box a
              positioned-ancestor guard would compare it against
            </Text>
          </div>
          <div data-geo="container" style={{ width: STRIP_CARD_PX }}>
            <Line ref={hostRef} className="w-full">
              <AdaptiveBar gap="xs" align={align} label="Strip actions">
                <AdaptiveBar.Item id="search">
                  <span data-geo="search">
                    <IconButton
                      icon={searchIcon}
                      label="Search"
                      onClick={() => {}}
                    />
                  </span>
                </AdaptiveBar.Item>
                <AdaptiveBar.Item id="share">
                  <span data-geo="share">
                    <IconButton
                      icon={shareIcon}
                      label="Share"
                      onClick={() => {}}
                    />
                  </span>
                </AdaptiveBar.Item>
                <AdaptiveBar.Item id="settings">
                  <span data-geo="settings">
                    <IconButton
                      icon={settingsIcon}
                      label="Settings"
                      onClick={() => {}}
                    />
                  </span>
                </AdaptiveBar.Item>
              </AdaptiveBar>
            </Line>
          </div>
        </Stack>
      </div>
    </Scroll>
  );
}

// Spread rather than written literally, so the box the fixture marks and the box
// the mutation goes looking for cannot drift apart. Typed as a Record so the
// spread is not a fresh object literal, which JSX would excess-property-check.
const HOST_MARKER_PROPS: Record<string, string> = { [HOST_MARKER_ATTR]: "" };

/**
 * The four numbers the `host-stops-giving-room` sweep is built out of, and the
 * one arithmetic they have to satisfy.
 *
 * The fixture proves a guard whose whole subject is *how much room the row was
 * given versus how much it is using*, so the sweep cannot be a few plausible
 * widths — each one has to put the bar in a specific state. At every swept width
 * the row must (a) hold at least one occupant, since a probe that hides nothing
 * measures nothing, (b) have evicted at least one, since a full row is not using
 * less than it was given, and (c) still leave a band of UNUSED room wider than
 * the primitive's own `HYSTERESIS_PX`, since that unused room is exactly how far
 * the row narrows when the host stops handing it a width — and a narrowing
 * smaller than the hysteresis band is not a resize as far as the bar is
 * concerned.
 *
 * So the width is computed from the state it is meant to produce rather than
 * picked: `n` occupants inline, each followed by a gap (the last one by the gap
 * before the `⋯`), then the trigger, then the slack band. The occupants are a
 * fixed pixel width for the same reason — a text-sized chip makes every number
 * here a function of the font, and the row is being measured to the pixel.
 *
 * `ROOM_GAP_PX` and `ROOM_TRIGGER_PX` are measured off the harness's own seeded
 * default density ramp (`gap="xs"`, one `IconButton`) rather than derived, which
 * is the one thing in here that could go stale. `ROOM_SLACK_PX` is what absorbs
 * that: it sits mid-way between the 8px floor the probe needs and the ~100px
 * ceiling at which one more occupant would fit instead, so both constants can
 * drift by tens of pixels before any of (a), (b) or (c) stops holding.
 */
const ROOM_OCCUPANT_PX = 96;
const ROOM_GAP_PX = 4;
const ROOM_TRIGGER_PX = 32;
const ROOM_SLACK_PX = 40;

function roomWidthFor(inlineOccupants: number): number {
  return (
    inlineOccupants * (ROOM_OCCUPANT_PX + ROOM_GAP_PX) +
    ROOM_TRIGGER_PX +
    ROOM_SLACK_PX
  );
}

const ROOM_IDS = ["align", "colour", "layer", "share"] as const;

/**
 * A rigid, fixed-width occupant: one rung, and a width no font can move.
 *
 * It carries its own `data-geo`, rather than the fixture stamping the bar's item
 * containers the way {@link useOccupantGeoSlots} does, because here an occupant
 * has to be measurable the FIRST time it is ever in the row. A stamp applied by
 * querying the row only ever finds what is already in it, and the occupant this
 * fixture most needs to see is the one that was behind the `⋯` at every healthy
 * width and comes back only when the bar degrades. Marking the widget itself
 * means the marker travels with it: into the body-portaled panel, where it is
 * outside the measured subtree and correctly invisible, and back.
 */
function RoomChip({ id }: { id: string }): ReactElement {
  return (
    <div
      data-geo={id}
      className="rounded-md border px-xs py-2xs"
      style={{ width: ROOM_OCCUPANT_PX }}
    >
      {id}
    </div>
  );
}

/**
 * An ordinary, healthy bar — inside a host that can be taken away from it.
 *
 * Nothing here is wrong, and that is the requirement rather than an aesthetic
 * choice: this same catalog is what the Debug Exhibits gallery renders, inside the app,
 * where the bar's report collector is registered. A fixture that simply IS badly
 * hosted would file a real `no-slack` report every time a human opened Debug →
 * Exhibits gallery — a permanent decoy in the alert funnel, for a fixture working as
 * designed. Mutations are a gate-only concept; the gallery never applies one, so
 * what the Lab shows is what is written here: a full-width row, four chips, and
 * a `⋯` holding the rest.
 *
 * The marked wrapper is the whole apparatus. It is an ordinary full-width block
 * that hands the row its width, until `shrinkWrapHost` reverses that — after the
 * bar has mounted, settled, and evicted down to a fit, which is when the bar's
 * own decisions start feeding back into the width that produced them.
 *
 * What that then proves is the SCHEDULE of the premise check, not the check
 * itself. The bar verifies "my width is given to me, not taken from my content"
 * by hiding the row's occupants and re-reading the row; a bar that asks only at
 * mount has already asked, correctly, and passes this mutation while ratcheting
 * itself empty afterwards. The two outcomes are told apart by geometry alone,
 * which is all the gate can see (the measurer page is a production build, so the
 * fault's dev throw is compiled out, and it registers no report collector):
 *
 * - **asked again** — the probe catches the reversal, the bar stops believing
 *   its width and degrades to the CEILING: every occupant back in the row at its
 *   widest, CSS clipping. The row is now content-wide, the four chips together
 *   are wider than the container at every swept width, and `noClip` fails.
 * - **asked once** — the bar goes on trusting a width that is now its own last
 *   eviction's output, and the ratchet has already run: the row stays at the one
 *   chip it had narrowed to, three chips stranded behind the `⋯`, with most of
 *   the container's own room unused beside it and no width that can give them
 *   back. Nothing sticks out of anything, so `noClip` passes and the gate
 *   reports `falsification did not bite`. (Measured, with the re-probe removed.)
 */
function HostStopsGivingRoomFixture(): ReactElement {
  const hostRef = useTriggerGeoSlot();
  return (
    // The host: full-width and growing normally, exactly as the bar's one rule
    // for consumers asks. `w-full` is a class rather than an inline width so the
    // mutation's inline `max-content` can win over it.
    <div {...HOST_MARKER_PROPS} className="w-full">
      <Line ref={hostRef} className="w-full">
        <AdaptiveBar gap="xs" label="More tools">
          {ROOM_IDS.map((id) => (
            <AdaptiveBar.Item key={id} id={id}>
              <RoomChip id={id} />
            </AdaptiveBar.Item>
          ))}
        </AdaptiveBar>
      </Line>
    </div>
  );
}

export const adaptiveBarExhibits: Exhibit[] = [
  isolatedExhibit({
    // The load-bearing one: a draggable `role="slider"` and a two-rung volume
    // control sharing a row with three plain actions, swept from roomy to
    // cramped. Nothing here is an action, an action-shaped thing, or a menu row.
    //
    // Its 220px end doubles as a no-slack negative control, for the reason
    // spelled out at `actions-only` below — a false accusation would put the jog
    // wheel and the full volume slider back in a 220px row and blow `noClip`.
    id: "adaptive-bar/rich-widgets",
    label: "Rich widgets",
    widths: [720, 560, 440, 320, 220],
    render: () => <RichBarFixture />,
    geometry: {
      dims: { contentLen: "long", withMeta: true, state: "idle" },
      invariants: [{ kind: "noOverlap" }, { kind: "noClip" }],
    },
  }),
  isolatedExhibit({
    // The ordinary case a pane header actually is: every occupant an
    // `IconButton`, so every one of them declares the `"row"` rung and the panel
    // fills with labelled rows.
    //
    // **Its narrow widths are also the no-slack guard's negative control — do
    // not trim them.** This bar is hosted correctly (a `w-full` `Line`, the bar
    // the growing cell), and the guard re-verifies that premise every time the
    // row narrows past the width it last held at, so this sweep asks the
    // question four times over, down to 60px. A guard that accused a healthy
    // host would latch the degraded ceiling — every occupant back inline at its
    // widest — and three `IconButton`s do not fit in 60px, so `noClip` above
    // would fail. "The guard does not accuse a well-hosted bar" is therefore
    // asserted here, against a real layout engine, rather than assumed;
    // `rich-widgets` says the same thing at 220px with richer occupants, and
    // `host-stops-giving-room` is the positive half of the same pair.
    //
    // The two `inside-horizontal-strip` fixtures are NOT controls: their card is
    // 360px and roomy, so a false accusation there would still fit.
    id: "adaptive-bar/actions-only",
    label: "Actions only",
    widths: [400, 300, 200, 120, 60],
    render: () => <ActionsBarFixture />,
    geometry: {
      dims: { contentLen: "short", withMeta: false, state: "idle" },
      invariants: [{ kind: "noOverlap" }, { kind: "noClip" }],
    },
  }),
  isolatedExhibit({
    // The width ledger's axiom, measured. The only fixture whose occupants CAN
    // be squeezed (a truncating `<Text>` leaf, min-content ≈ 0), so the only one
    // that can tell whether the row's `[&>*]:shrink-0` is doing anything.
    //
    // The widths are chosen so every slot is inline at more than one of them
    // with a DIFFERENT number of neighbours — a slot present at only one width
    // satisfies `rigidIntegrity` trivially, and the whole question is whether
    // the neighbours change the answer.
    id: "adaptive-bar/squeezable-occupants",
    label: "Squeezable occupants",
    widths: [880, 700, 520, 340],
    render: () => <SqueezableBarFixture />,
    geometry: {
      dims: { contentLen: "long", withMeta: false, state: "idle" },
      invariants: [
        { kind: "noOverlap" },
        { kind: "noClip" },
        ...SQUEEZABLE_IDS.map(
          (slot) => ({ kind: "rigidIntegrity", slot }) as const,
        ),
        // And the proof that the assertion above bites. `shrinkSlots` hands the
        // measured boxes back to the engine — `flex: 0 1 auto` + `min-width: 0`,
        // what an ordinary flex item is — which is precisely the state this whole
        // change removed: the occupants absorb the row's deficit, their widths
        // become a function of the placement, and `rigidIntegrity` must fail.
        //
        // Without it this would be the one invariant in the catalog with nothing
        // to say it is not vacuous, and a fixture whose labels turned out short
        // enough never to crowd its row would pass forever while proving nothing.
        {
          kind: "falsification",
          mutate: { kind: "shrinkSlots" },
          expectViolated: { kind: "rigidIntegrity", slot: "alpha" },
        },
      ],
    },
  }),
  isolatedExhibit({
    // The regression fixture for the guard that took the Exhibits gallery down: a bar
    // whose own row is roomy, parked far from its nearest positioned ancestor.
    //
    // The width sweep is deliberately inert for the bar — the strip and the
    // card are authored, so widening the harness only widens the SCROLL
    // VIEWPORT the strip overruns. That is itself the assertion: the bar's
    // geometry must depend on the box it was given and on nothing else, and the
    // narrower harness width is the harsher case (the offset relative to the
    // positioned ancestor is larger, not smaller).
    //
    // `rigidIntegrity` is here for a reason the other two invariants cannot
    // cover, and it is the load-bearing one rather than a belt-and-braces
    // extra. `noOverlap` and `noClip` both skip a slot that is absent, and once
    // a fault is terminal this bug PRESENTS as every occupant floored into the
    // panel and gone from the row — geometrically serene, and completely wrong.
    // The measurer page is a Vite PRODUCTION build, so the bar's dev-only throw
    // is compiled out and the page-error drain never hears about it; the quiet
    // branch is the only branch the gate can see. `rigidIntegrity` fails on a
    // slot that is never present across the sweep, so "the three actions are
    // still in the row, at the same width" is asserted rather than assumed.
    id: "adaptive-bar/inside-horizontal-strip",
    label: "Inside a horizontal strip (start)",
    widths: [720, 320],
    render: () => <StripBarFixture align="start" />,
    geometry: {
      dims: { contentLen: "short", withMeta: false, state: "idle" },
      invariants: [
        { kind: "noOverlap" },
        { kind: "noClip" },
        { kind: "rigidIntegrity", slot: "search" },
        { kind: "rigidIntegrity", slot: "share" },
        { kind: "rigidIntegrity", slot: "settings" },
      ],
    },
  }),
  isolatedExhibit({
    // The same shape with `align="end"`, and it is not redundant with the one
    // above — it is the direction a right-edge-only guard cannot see at all.
    //
    // `align="end"` packs the occupants against the far edge, so an over-full
    // row spills to the LEFT, and LTR scrollable overflow does not account for
    // content past the left edge: `root.scrollWidth` reads exactly equal to
    // `clientWidth` on a row overflowing that way (measured in Chromium, not
    // assumed). Any guard phrased as "does the content stick out to the right"
    // is blind here — and this is not an exotic configuration, it is what every
    // pane header in the app renders. So the guard is exercised in this
    // direction too, on the same strip shape, rather than leaving it to the
    // synthetic spans in the primitive's own unit tests.
    id: "adaptive-bar/inside-horizontal-strip-end",
    label: "Inside a horizontal strip (end)",
    widths: [720, 320],
    render: () => <StripBarFixture align="end" />,
    geometry: {
      dims: { contentLen: "short", withMeta: false, state: "idle" },
      invariants: [
        { kind: "noOverlap" },
        { kind: "noClip" },
        { kind: "rigidIntegrity", slot: "search" },
        { kind: "rigidIntegrity", slot: "share" },
        { kind: "rigidIntegrity", slot: "settings" },
      ],
    },
  }),
  isolatedExhibit({
    // The only fixture in the catalog that puts the `no-slack` guard in front of
    // a real layout engine. Every other one hands the bar a proper growing cell,
    // which is what a fixture SHOULD do — so the badly-hosted shape only ever
    // existed in the jsdom suite, modelled through the primitive's measurement
    // seam, and no browser had ever produced the ratchet it exists to catch.
    //
    // Unmutated it is an ordinary bar and asserts what its siblings assert; the
    // falsification is the fixture's reason to exist. See
    // {@link HostStopsGivingRoomFixture} for what the mutation does and how the
    // two outcomes are told apart by geometry.
    //
    // The widths run WIDE → NARROW, and the order is load-bearing twice over.
    // One mounted bar serves the whole run — the harness re-renders the same
    // component per width, so the instance, its refs and the mutation's inline
    // style all survive from one width to the next — and the mutated pass
    // restarts at `widths[0]` carrying the state the healthy pass left behind.
    //
    // **It is what makes the un-degraded outcome fit.** The mutation is applied
    // synchronously right after the render commits, before the resize observer
    // has re-fitted the row for the new width, so `max-content` freezes the row
    // holding the PREVIOUS width's occupants. Restarting narrower would freeze a
    // wide row inside a narrow container and violate `noClip` on the spot —
    // with or without the guard, which is a falsification that proves nothing.
    // Restarting at the widest inherits the narrowest row instead: comfortably
    // inside the container, so the degraded ceiling is the only thing left that
    // can spill it.
    //
    // **And it is what leaves the premise stale in the direction the guard
    // watches.** The re-probe follows the row NARROWING past the width the
    // premise last held at; narrow → wide would leave that mark at the first
    // width and the frozen row would be wider than it, which the guard is
    // documented not to re-ask about. Descending drags the mark down to the
    // narrowest width, and the frozen row lands below it.
    //
    // Two widths rather than the four or five its siblings sweep, because each
    // narrowing spends one of the bar's budgeted probes (`MAX_SLACK_PROBES`)
    // and the mutated pass needs one left. A longer sweep buys nothing here — the fault
    // is latched at the first mutated width — and would spend the budget the
    // proof runs on, reading as `falsification did not bite` while the guard is
    // in fact working.
    id: "adaptive-bar/host-stops-giving-room",
    label: "Host stops giving room",
    widths: [roomWidthFor(3), roomWidthFor(1)],
    render: () => <HostStopsGivingRoomFixture />,
    geometry: {
      dims: { contentLen: "short", withMeta: false, state: "idle" },
      invariants: [
        { kind: "noOverlap" },
        { kind: "noClip" },
        // Last in the list, and it has to stay last. The healthy sweep is measured
        // once up front, so it is safe wherever it sits — but this mutation is not
        // undone by a re-render: the bar latches the degraded ceiling for the rest
        // of the mount, and the harness keeps ONE mounted instance for the whole
        // fixture. Anything measured after it would be measuring a bar that has
        // already given up.
        {
          kind: "falsification",
          mutate: { kind: "shrinkWrapHost" },
          expectViolated: { kind: "noClip" },
        },
      ],
    },
  }),
];
