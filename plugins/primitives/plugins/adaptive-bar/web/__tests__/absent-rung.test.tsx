import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useActionForm } from "@plugins/primitives/plugins/action-presentation/web";
import { AdaptiveBar, adaptiveBarReportSink } from "../index";
import { AdaptiveBarMeasure } from "../testing";
import type { AdaptiveBarFault } from "../internal/diagnostics";

/**
 * A widget that renders nothing at a rung must not make the bar flip forever.
 *
 * The defect: "this occupant renders nothing" was recorded as a property of the
 * OCCUPANT, from the DOM, at whatever rung it happened to be sitting at. So an
 * occupant that renders content as `full` and nothing as `compact` cycled —
 * placed at rung 0, it rendered, the fit demoted it to rung 1, it rendered
 * nothing, the fit dropped it from the placement ("there is nothing to place"),
 * the web half read the hole as rung 0 ("this item has never been placed"), and
 * round 1 came back. The round budget stopped it with a `no-convergence` fault
 * and a cramped toolbar; nothing made the cycle unspellable.
 *
 * These are control-flow claims, not pixel ones, so jsdom is the right place for
 * them: widths come through the primitive's own measurement seam, and the fit,
 * both ledgers and the reporting all run as they do in a browser.
 */

const TRIGGER_PX = 30;
const FULL_PX = 160;
const COMPACT_PX = 80;
/** Two full occupants fit; three do not. */
const ROOM = 400;
/**
 * The same row, one pixel too narrow to take the two survivors back at full
 * width once the third has left (2×160 + 30 + `HYSTERESIS_PX` = 358).
 *
 * H1 refuses a promotion that does not clear the band, so this is where a round
 * that evicted an occupant for reasons other than width would LATCH: everything
 * out of the row is a stable placement, the fit says it fits, and the bar
 * converges silently on an empty row with a `⋯`.
 */
const TIGHT_ROOM = 356;

let faults: AdaptiveBarFault[] = [];
let room = ROOM;
/** Which occupants were docked in the row, once per measure-and-decide pass. */
let inlineByPass: string[][] = [];

/**
 * Widths come from what is actually rendered, which is the whole point here: an
 * occupant that rendered nothing has no child and therefore no width, exactly as
 * the browser would report it.
 */
function measureFake(el: Element): number {
  if (el.hasAttribute("data-adaptive-bar-trigger")) return TRIGGER_PX;
  if (!el.hasAttribute("data-adaptive-bar-item")) {
    // The row's own width is read once per pass, after the committed placement
    // has been docked — so this is the sampling point for what the row HELD on
    // every round, not just at the end.
    inlineByPass.push(inlineIds());
    return room;
  }
  const probe = el.querySelector("[data-w]");
  return probe === null ? 0 : Number(probe.getAttribute("data-w"));
}

/** An ordinary occupant: it renders a narrower form of itself when asked. */
function Shrinking({ id }: { id: string }): ReactElement {
  const form = useActionForm({ shrinksTo: ["compact"] });
  return (
    <span data-probe={id} data-w={form === "compact" ? COMPACT_PX : FULL_PX} />
  );
}

/** The defect's shape: it declares a compact form and renders nothing as one. */
function VanishesWhenCompact({ id }: { id: string }): ReactElement | null {
  const form = useActionForm({ shrinksTo: ["compact"] });
  if (form === "compact") return null;
  return <span data-probe={id} data-w={FULL_PX} />;
}

/**
 * The supported case, and the one that must stay silent: a contribution that
 * renders nothing at all. It is not an occupant, and never was.
 */
function RendersNothing(): null {
  useActionForm({ shrinksTo: ["compact"] });
  return null;
}

function Bar({ third }: { third: ReactElement | null }): ReactElement {
  return (
    // A fresh arrow every render, so a re-render re-runs the pass — the stand-in
    // for the ResizeObserver, which cannot fire in jsdom.
    <AdaptiveBarMeasure measure={(el) => measureFake(el)}>
      <AdaptiveBar gap="xs" label="Vanishing">
        <AdaptiveBar.Item id="alpha">
          <Shrinking id="alpha" />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="beta">
          <Shrinking id="beta" />
        </AdaptiveBar.Item>
        <AdaptiveBar.Item id="gamma">{third}</AdaptiveBar.Item>
      </AdaptiveBar>
    </AdaptiveBarMeasure>
  );
}

function container(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-adaptive-bar-item="${id}"]`,
  );
}

/** The bar's own row — the element the `⋯` trigger is a child of. */
function barRow(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("[data-adaptive-bar-trigger]")
      ?.parentElement ?? null
  );
}

/** Is this occupant still docked in the row itself, rather than in the panel? */
function isInline(id: string): boolean {
  const el = container(id);
  return el !== null && el.parentElement === barRow();
}

function inlineIds(): string[] {
  const row = barRow();
  if (row === null) return [];
  return [...row.querySelectorAll<HTMLElement>("[data-adaptive-bar-item]")]
    .filter((el) => el.parentElement === row)
    .map((el) => el.getAttribute("data-adaptive-bar-item") ?? "");
}

beforeEach(() => {
  faults = [];
  room = ROOM;
  inlineByPass = [];
  // The production path is the one under test: in dev `failLoudly` throws, which
  // unmounts the tree and hides what the bar does NEXT.
  vi.stubEnv("DEV", false);
  adaptiveBarReportSink.register((fault) => faults.push(fault));
});

afterEach(() => {
  adaptiveBarReportSink.register(null);
  vi.unstubAllEnvs();
  cleanup();
});

describe("an occupant that renders nothing at its compact rung", () => {
  it("settles instead of flipping between rung 0 and rung 1 forever", () => {
    const { rerender } = render(
      <Bar third={<VanishesWhenCompact id="gamma" />} />,
    );
    for (let i = 0; i < 4; i += 1)
      rerender(<Bar third={<VanishesWhenCompact id="gamma" />} />);

    // The flip's signature was the round budget running out with the placement
    // still moving. It cannot be reached now: the bar never offers a rung it has
    // seen the occupant render nothing at, so it can never un-place it for
    // having rendered nothing.
    expect(faults.filter((f) => f.kind === "no-convergence")).toEqual([]);
  });

  it("keeps the widget visible rather than parking it where it renders nothing", () => {
    render(<Bar third={<VanishesWhenCompact id="gamma" />} />);

    // Relocation, not vanishing: with no compact form it can actually render,
    // the bar takes it out of the row — where it renders as itself, behind the
    // `⋯` — instead of leaving it sitting inline as a blank.
    const gamma = container("gamma");
    expect(gamma).not.toBeNull();
    expect(gamma?.childElementCount).toBeGreaterThan(0);
    expect(gamma?.hidden).toBe(false);
    expect(isInline("gamma")).toBe(false);
    // And the two that can shrink are still in the row.
    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(true);
  });

  it("never takes the other occupants out of the row to pay for it", () => {
    render(<Bar third={<VanishesWhenCompact id="gamma" />} />);

    // The property the primitive sells: a resize that relocates one widget
    // leaves the others — their focus, transitions and scroll offsets — alone.
    // Invalidating the vanishing widget's WIDTHS when its rung was cut broke it
    // silently: with rung 0 downgraded and no wider rung to bound it, the fit
    // could no longer size that occupant, `doesFit` was false at every width,
    // and one round walked alpha and beta into the body-portaled panel and the
    // next brought them back. The end state looked perfect.
    expect(inlineByPass.length).toBeGreaterThan(1);
    for (const held of inlineByPass) {
      expect(held).toContain("alpha");
      expect(held).toContain("beta");
    }
  });

  it("settles on a row too tight to take the survivors back at full width", () => {
    // H1 refuses a promotion that does not clear the band, so a round that
    // evicted alpha and beta on non-width grounds would latch: everything out of
    // the row is a stable placement that the fit agrees fits, and the bar
    // converges on an empty row, silently, with nothing filed.
    room = TIGHT_ROOM;
    render(<Bar third={<VanishesWhenCompact id="gamma" />} />);

    expect(faults.filter((f) => f.kind === "no-convergence")).toEqual([]);
    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(true);
    expect(isInline("gamma")).toBe(false);
  });

  it("says so once, and names the widget as a field rather than only in prose", () => {
    const { rerender } = render(
      <Bar third={<VanishesWhenCompact id="gamma" />} />,
    );
    for (let i = 0; i < 4; i += 1)
      rerender(<Bar third={<VanishesWhenCompact id="gamma" />} />);

    const empty = faults.filter((f) => f.kind === "empty-rung");
    expect(empty).toHaveLength(1);
    // Typed, not just phrased: this is the one fault whose subject is a specific
    // contributor, and the id is what a reader filters and fingerprints on.
    expect(empty[0]?.item).toEqual({ id: "gamma", rung: 1, form: "compact" });
    expect(empty[0]?.message).toContain("gamma");
    expect(empty[0]?.label).toBe("Vanishing");
  });
});

describe("an occupant that renders nothing at all", () => {
  it("is not an occupant, and is not a fault", () => {
    const { rerender } = render(<Bar third={<RendersNothing />} />);
    for (let i = 0; i < 4; i += 1) rerender(<Bar third={<RendersNothing />} />);

    // A contribution that renders nothing is ordinary and supported — it has a
    // host and a 0×0 container and costs the row no width and no gap. Reporting
    // it would make every conditional contribution in the app a finding.
    expect(faults).toEqual([]);
    expect(container("gamma")?.hidden).toBe(true);
    // Two 160px occupants fit 400px of row, so nothing had to give.
    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(true);
  });
});

describe("an occupant whose content arrives later, inside a display: contents box", () => {
  it("is shown once something renders in it, though its own child list never changed", async () => {
    // The file preview's header-action host: an empty `contents` span the
    // occupant renders at once, which ANOTHER tree (the active renderer) portals
    // its action into later. The container's direct children never change, so
    // a child-list-only observer left it `hidden` for good — the MIDI preview's
    // Open in Sonata was in the DOM but never drawn.
    // Filled by a plain DOM insert, as another React tree's portal would: no
    // re-render of the bar (which would re-run its pass and hide the defect),
    // so only the mutation itself can reveal the occupant.
    function LateHost(): ReactElement {
      return <span data-late-host="" style={{ display: "contents" }} />;
    }
    render(<Bar third={<LateHost />} />);
    expect(container("gamma")?.hidden).toBe(true);

    const host = document.querySelector("[data-late-host]");
    if (host === null) throw new Error("late host not mounted");
    const action = document.createElement("span");
    action.setAttribute("data-probe", "gamma");
    action.setAttribute("data-w", String(FULL_PX));
    act(() => {
      host.append(action);
    });
    await waitFor(() => expect(container("gamma")?.hidden).toBe(false));
    expect(faults).toEqual([]);
  });
});
