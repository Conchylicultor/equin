import { cloneElement, type ReactElement, type ReactNode } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";

// ── The one child kit every region is measured against ──────────────
//
// This kit is NOT authorable by the fixture, and that is the entire mechanism.
//
// Every geometry-gated `isolated` exhibit renders children it wrote itself, so a container is only
// ever measured against the child kind it already handles. `control-panel` shows
// what that costs: five fixtures, all green, all rendering `Row`s — while a raw
// `<Input>` dropped into a panel sat ~50px left of every label around it. Three
// geometry bugs shipped that way, and the remedy on the books was a sentence in
// a CLAUDE.md asking authors to please render something other than a `Row`. A
// sentence is rung 5 of the fix ladder; this file is rung 1, because a region
// fixture has nowhere to say what its children are.
//
// So a member is added HERE, once, and every region in the repo is re-gated by
// it — including the ones contributed before the member existed. Adding a kind
// of child that regions get wrong is how this gate grows teeth over time.
//
// ### What belongs in the kit
//
// Children that know NOTHING about the rail. A child that opts in (a rail class,
// a wrapper that re-insets) proves nothing: it would land correctly against a
// region that published a wrong number, because it would be reading the same
// wrong number. The one exception is deliberate and named — `bled-row` exercises
// the escape hatch, whose whole contract is that cancel-and-reapply lands the
// content back on exactly the rail it cancelled.

/**
 * The measurement box a member is marked on.
 *
 * `data-geo` cannot go on the component itself: an `<Input>` has its own border
 * and inline padding, so its CONTENT edge sits ~13px inside its box and the slot
 * would read a rail that is 13px off for no reason a region could fix. The probe
 * is a padding-free, border-free block that fills the region's inline axis, so
 * its content edge IS its left edge IS the child's box edge — the same reason
 * `control-panel`'s fixtures measure through a `Fills` wrapper.
 *
 * It is layout-transparent in both region shapes: in a flex/grid column it is
 * one item like the child would have been, and in a block region a block box
 * fills the width anyway.
 */
function Probe({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span data-geo={id} className="block w-full">
      {children}
    </span>
  );
}

/** One member of the kit: its `data-geo` id and the node the region receives. */
export interface RegionChild {
  id: string;
  node: ReactElement;
}

/**
 * THE kit. Ordered as the harness renders them; `data-geo` ids are stable, so an
 * oracle failure names the member that broke rather than an index.
 */
export const REGION_CHILDREN: RegionChild[] = [
  {
    // The case that actually broke. A form control dropped straight into a
    // panel section is the commonest "content that knows nothing" there is, and
    // it is the one every row-only fixture was blind to.
    id: "bare-input",
    node: (
      <Probe id="bare-input">
        <Input
          keep={transient("layout harness fixture")}
          defaultValue="Untitled"
          aria-label="Region child input"
        />
      </Probe>
    ),
  },
  {
    // A shrink-to-fit control, where the input is a stretch-to-fill one. The
    // probe normalizes both to a full-width box, so what differs is what the
    // REGION does with them: a region that lays its children out by content
    // (an inline-flex band, a grid whose tracks size to their items) treats the
    // two differently, and only one of them is in every existing fixture.
    id: "bare-button",
    node: (
      <Probe id="bare-button">
        <Button variant="outline">Newest first</Button>
      </Probe>
    ),
  },
  {
    // Bare prose — no chrome of its own at all. The case a region insetting via
    // a per-child rule (`> input`, `.some-control { padding-inline }`) rather
    // than by opening a region gets wrong: its styled children move, its text
    // does not.
    id: "bare-text",
    node: (
      <Probe id="bare-text">
        <Text variant="body">Runs after the worktree is created</Text>
      </Probe>
    ),
  },
  {
    // How a CONTRIBUTED panel actually arrives. `renderIsolated` wraps every
    // contribution in a lineage span, and those spans are `display: contents` —
    // transparent to layout, opaque to selectors. A region that insets with a
    // child-adjacency selector (`> * + *`, `:first-child`) sees one span and
    // matches nothing, so the contributed child sits flush while the fixture's
    // own hand-written children look fine. Custom-property inheritance passes
    // straight through, which is exactly why the rail is a var pair.
    id: "contents-wrapped",
    node: (
      <div style={{ display: "contents" }}>
        <Probe id="contents-wrapped">
          <Text variant="body">Contributed by another plugin</Text>
        </Probe>
      </div>
    ),
  },
  {
    // The only member that APPLIES anything itself, and therefore the only one
    // that can catch a double-pay.
    //
    // Two topologies exist in this repo. In most places the region pads and its
    // children inherit by doing nothing — the four members above. In data-view
    // the inverse holds: the bands inset themselves with `rail-follow` and the
    // container does not pad. Put a follower under a region that DOES pad and it
    // applies the inset a second time; 24px silently becomes 48px. That is why
    // the rail publishes a second pair, `--rail-owed-*` — what a follower still
    // owes, which the `rail-<step>` ramp sets to `0px` because the owner already
    // paid.
    //
    // Nothing about `railAlignment` changes to accommodate this: it measures
    // content against `railOrigin + railStart`, which BOTH topologies satisfy
    // when correct. The oracle stays topology-blind; the kit is what makes the
    // second topology present at all. Without this member the gate measures five
    // children that all inherit — the same shape of blindness as measuring only
    // `Row`s.
    //
    // The probe goes INSIDE the follower rather than on it: `contentLeft` would
    // see a debt paid as padding, but not one paid as margin or as a nested box,
    // and the harness is supposed to measure where content lands rather than the
    // mechanism that put it there.
    id: "follower",
    node: (
      <div className="rail-follow">
        <Probe id="follower">
          <Text variant="body">A band that insets itself</Text>
        </Probe>
      </div>
    ),
  },
  {
    // The escape, exercised as a member rather than described in a doc.
    // `rail-bleed` cancels the region's inset with negative inline margins and
    // re-applies it as its own padding, in ONE class — so the box reaches the
    // region's edge (that full-width hover fill is what makes a row read as a
    // row) while the CONTENT comes back to the same rail everything else is on.
    //
    // `data-geo` sits on the bleeding element itself, not on a wrapper: the two
    // halves of the escape are its margin and its padding, and only
    // `contentLeft` (`rect.left + paddingLeft`) sees both. A wrapper would
    // measure the bled box edge and read the escape as a violation.
    id: "bled-row",
    node: (
      <div data-geo="bled-row" className="rail-bleed">
        <Text variant="body">A row that bleeds and comes back</Text>
      </div>
    ),
  },
];

/**
 * The attribute marking the harness's own wrapper around the kit — the element
 * `__measure` reads the published rail from, and the element `railOverride`
 * re-publishes it on.
 *
 * It has to be read from INSIDE the region rather than off the harness's width
 * wrapper, because custom properties inherit DOWN: the region publishes on its
 * own box, which is a descendant of the container. Reading it where the children
 * read it is also the honest question — "what rail do the children see?" — and
 * it is what lets `__measure` find the publishing box by walking back up.
 */
export const RAIL_MARKER_ATTR = "data-geo-rail";

// Spread rather than written literally, so the marker and the selector
// `__measure` finds it with cannot drift apart. Typed as a Record so the spread
// is not a fresh object literal, which JSX would excess-property-check.
const RAIL_MARKER_PROPS: Record<string, string> = { [RAIL_MARKER_ATTR]: "" };

/**
 * The kit, wrapped in the harness's `display: contents` rail marker.
 *
 * The marker generates no box, so it changes nothing about how the region lays
 * its children out — it is the same transparency `renderIsolated` relies on, and
 * the `contents-wrapped` member above proves the region survives it.
 */
export function RegionChildren(): ReactElement {
  return (
    <div {...RAIL_MARKER_PROPS} style={{ display: "contents" }}>
      {/* `cloneElement` for the key rather than a keyed wrapper: a wrapper would
          make EVERY member `display: contents`, which is one of the members —
          `contents-wrapped` only tests anything while its siblings are plain. */}
      {REGION_CHILDREN.map((child) =>
        cloneElement(child.node, { key: child.id }),
      )}
    </div>
  );
}
