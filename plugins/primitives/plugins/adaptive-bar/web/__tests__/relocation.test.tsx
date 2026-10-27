import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
  useActionForm,
  type ActionForm,
  type YieldEagerness,
} from "@plugins/primitives/plugins/action-presentation/web";
import { PortalForwardProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useReportPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { AdaptiveBar } from "../index";
import { AdaptiveBarMeasure } from "../testing";

/**
 * The claim this whole primitive rests on is *one instance that relocates*, and
 * jsdom is where it can be settled: geometry needs a browser, but "did React
 * unmount this subtree" is a question about fibers, not pixels.
 *
 * jsdom has no layout engine — every rect is zero and the shared
 * `ResizeObserver` stub is inert — so the widths come through the primitive's
 * own measurement seam. That is not a mock of the logic under test: the fit
 * math, the docking, the pins and the panel all run exactly as they do in a
 * browser; only the source of the numbers differs.
 */

const TRIGGER_PX = 30;

/** Per-item widths, by rung. Mutated per test to drive a relocation. */
const WIDTHS: Record<string, Partial<Record<ActionForm, number>>> = {
  alpha: { full: 100, compact: 40 },
  beta: { full: 100, compact: 40 },
  gamma: { full: 100, compact: 40 },
};

/** The row's available width. Mutated per test, then re-rendered. */
let available = 1000;

/** Mounts and unmounts per item id — the single-instance ledger. */
const mounts: Record<string, number> = {};
const unmounts: Record<string, number> = {};
let instanceSeq = 0;

function measureFake(el: Element): number {
  if (el.hasAttribute("data-adaptive-bar-trigger")) return TRIGGER_PX;
  const id = el.getAttribute("data-adaptive-bar-item");
  if (id === null) return available;
  const child = el.querySelector("[data-form]");
  // No child element means the contribution rendered nothing: absent, not a
  // width of zero. The primitive decides that from the DOM, so the fake has
  // nothing to say about it.
  if (child === null) return 0;
  const form = child.getAttribute("data-form") as ActionForm;
  return WIDTHS[id]?.[form] ?? 0;
}

/**
 * One occupant. Bumps a module counter on mount, and carries an identity minted
 * once per mount — so "the counter is still 1 and the identity is unchanged"
 * says the SAME React instance came out the far side of a re-parent.
 */
function Probe({
  id,
  shrinks = true,
  yields,
  extra,
}: {
  id: string;
  shrinks?: boolean;
  yields?: YieldEagerness;
  extra?: ReactNode;
}): ReactElement {
  const form = useActionForm({
    ...(shrinks ? { shrinksTo: ["compact"] as const } : {}),
    ...(yields === undefined ? {} : { yields }),
  });
  const [instance] = useState(() => (instanceSeq += 1));
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
    return () => {
      unmounts[id] = (unmounts[id] ?? 0) + 1;
    };
  }, [id]);
  return (
    <span data-form={form} data-instance={String(instance)} data-probe={id}>
      {id}
      {extra}
    </span>
  );
}

function Bar({ children }: { children: ReactNode }): ReactElement {
  return (
    // A fresh arrow every render, so a width change re-runs the pass — which is
    // what the ResizeObserver does in a browser and cannot do here.
    <AdaptiveBarMeasure measure={(el) => measureFake(el)}>
      <AdaptiveBar gap="xs" label="More">
        {children}
      </AdaptiveBar>
    </AdaptiveBarMeasure>
  );
}

function ThreeProbes(): ReactElement {
  return (
    <Bar>
      <AdaptiveBar.Item id="alpha">
        <Probe id="alpha" />
      </AdaptiveBar.Item>
      <AdaptiveBar.Item id="beta">
        <Probe id="beta" />
      </AdaptiveBar.Item>
      <AdaptiveBar.Item id="gamma">
        <Probe id="gamma" />
      </AdaptiveBar.Item>
    </Bar>
  );
}

function containerOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-adaptive-bar-item="${id}"]`,
  );
  if (el === null) throw new Error(`no container for bar item "${id}"`);
  return el;
}

/** Is this occupant still in the row, as opposed to relocated into the panel? */
function isInline(id: string): boolean {
  return containerOf(id).closest("[role='dialog']") === null;
}

function instanceOf(id: string): string | null {
  return (
    document
      .querySelector(`[data-probe="${id}"]`)
      ?.getAttribute("data-instance") ?? null
  );
}

function formOf(id: string): string | null {
  return (
    document.querySelector(`[data-probe="${id}"]`)?.getAttribute("data-form") ??
    null
  );
}

beforeEach(() => {
  available = 1000;
  instanceSeq = 0;
  for (const key of Object.keys(mounts)) delete mounts[key];
  for (const key of Object.keys(unmounts)) delete unmounts[key];
  for (const id of ["alpha", "beta", "gamma"]) {
    WIDTHS[id] = { full: 100, compact: 40 };
  }
});
afterEach(cleanup);

describe("one instance, ever", () => {
  it("relocates a widget into the panel without remounting it", () => {
    const { rerender } = render(<ThreeProbes />);
    expect(isInline("alpha")).toBe(true);
    expect(mounts["gamma"]).toBe(1);
    const gammaInstance = instanceOf("gamma");
    const gammaContainer = containerOf("gamma");

    // Room for one full-width occupant and the trigger, and nothing else.
    available = 140;
    rerender(<ThreeProbes />);

    expect(isInline("gamma")).toBe(false);
    // The claim, in three assertions: React never unmounted it, never built a
    // second one, and the node it lives in is the same node.
    expect(mounts["gamma"]).toBe(1);
    expect(unmounts["gamma"] ?? 0).toBe(0);
    expect(instanceOf("gamma")).toBe(gammaInstance);
    expect(containerOf("gamma")).toBe(gammaContainer);
  });

  it("brings it back inline as the same instance", () => {
    const { rerender } = render(<ThreeProbes />);
    const gammaInstance = instanceOf("gamma");

    available = 140;
    rerender(<ThreeProbes />);
    expect(isInline("gamma")).toBe(false);

    available = 1000;
    rerender(<ThreeProbes />);
    expect(isInline("gamma")).toBe(true);
    expect(mounts["gamma"]).toBe(1);
    expect(instanceOf("gamma")).toBe(gammaInstance);
  });

  it("shrinks a widget to a smaller form of itself rather than evicting it", () => {
    // 100 + 100 + 40 = 240 fits in 250; 300 does not. So the row keeps all three
    // and asks the first one to yield for a smaller form of itself — the ladder
    // is the whole reason a rung exists, and a bar that jumped straight to the
    // panel here would be the old mechanism with new names.
    const { rerender } = render(<ThreeProbes />);
    expect(formOf("alpha")).toBe("full");

    available = 250;
    rerender(<ThreeProbes />);

    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(true);
    expect(isInline("gamma")).toBe(true);
    // The tail yields first: same eagerness everywhere, so the tie goes to the
    // later occupant.
    expect(formOf("gamma")).toBe("compact");
    expect(formOf("alpha")).toBe("full");
  });

  it("takes an occupant to its narrowest rung before touching the next one", () => {
    // Worth pinning down because it is a real design choice, not an accident:
    // the search drains the eagest occupant to its floor — compact, then out of
    // the row — before it asks anyone else for anything. The alternative (one
    // step each, round-robin) would leave three half-shrunk widgets instead of
    // two intact ones.
    const { rerender } = render(<ThreeProbes />);
    available = 140;
    rerender(<ThreeProbes />);

    expect(formOf("alpha")).toBe("full");
    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(false);
    expect(isInline("gamma")).toBe(false);
  });

  it("hands the panel occupant the row form only when it offered one", () => {
    function Mixed(): ReactElement {
      return (
        <Bar>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" shrinks={false} />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="beta">
            <Probe id="beta" shrinks={false} />
          </AdaptiveBar.Item>
        </Bar>
      );
    }
    const { rerender } = render(<Mixed />);
    available = 130;
    rerender(<Mixed />);

    expect(isInline("beta")).toBe(false);
    // It never declared `"row"`, so the panel gets it as ITSELF. A jog wheel
    // cannot be a labelled row, and no region can make it one.
    expect(formOf("beta")).toBe("full");
  });
});

describe("the two contracts core imposes on the driver", () => {
  it("seeds a brand-new occupant at rung 0, never at null", () => {
    // `currentRung: null` means EVICTED, and there is no third state for
    // "unknown". Seeding a new item at `null` would make its first inline
    // placement read as a PROMOTION, so H1's band would hold it out of the row
    // until the bar grew by a further `hysteresisPx` — an action that simply
    // never appears after being contributed.
    function Bar1({ extra }: { extra: boolean }): ReactElement {
      return (
        <Bar>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" />
          </AdaptiveBar.Item>
          {extra ? (
            <AdaptiveBar.Item id="beta">
              <Probe id="beta" />
            </AdaptiveBar.Item>
          ) : null}
        </Bar>
      );
    }
    // A width with room for both, but only just: 100 + 100 = 200 ≤ 205, and the
    // margin is under HYSTERESIS_PX, so a spurious promote-band check would
    // refuse to seat the newcomer.
    available = 205;
    const { rerender } = render(<Bar1 extra={false} />);
    expect(isInline("alpha")).toBe(true);

    rerender(<Bar1 extra={true} />);
    expect(isInline("beta")).toBe(true);
    expect(formOf("beta")).toBe("full");
  });

  it("swaps two occupants between the row and the panel in one pass", () => {
    // The dock-ordering contract: `planMoves` reads `beforeId: null` as append,
    // which is only right once strays are gone. The inline pass runs first and
    // pulls the RETURNING occupant out of the panel, so the panel pass then sees
    // a dock holding exactly what it is about to arrange. Reversing the two
    // would plan an append past a node the plan assumed gone.
    //
    // Driven through declared eagerness rather than through widths, and that is
    // not a convenience: a panelled widget is never measured again, so changing
    // a panelled item's width is a change the bar cannot see. Eagerness is
    // per-instance and dynamic (the focused tab says `"never"`), so this is the
    // real shape of the case.
    function Row({
      alphaYields,
    }: {
      alphaYields: YieldEagerness;
    }): ReactElement {
      return (
        <Bar>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" shrinks={false} yields={alphaYields} />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="beta">
            <Probe id="beta" shrinks={false} />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="gamma">
            <Probe id="gamma" shrinks={false} />
          </AdaptiveBar.Item>
        </Bar>
      );
    }

    // 100 + 30 for the trigger fits in 140; two occupants do not. So exactly one
    // stays, and which one is decided purely by eagerness.
    available = 140;
    const { rerender } = render(<Row alphaYields="normal" />);
    expect(isInline("alpha")).toBe(true);
    expect(isInline("beta")).toBe(false);
    expect(isInline("gamma")).toBe(false);

    // alpha now yields first, so it leaves and beta — the next-least-eager —
    // comes back. Both moves in the same pass, in opposite directions.
    rerender(<Row alphaYields="early" />);

    expect(isInline("alpha")).toBe(false);
    expect(isInline("beta")).toBe(true);
    expect(isInline("gamma")).toBe(false);
    // Nobody was rebuilt on the way through, in either direction.
    expect(mounts["alpha"]).toBe(1);
    expect(mounts["beta"]).toBe(1);
    // The panel holds exactly the evicted set — the returning occupant is gone
    // from it, and nothing is in it twice.
    const dock = containerOf("alpha").parentElement;
    const docked = [...(dock?.children ?? [])].map((el) =>
      el.getAttribute("data-adaptive-bar-item"),
    );
    expect(docked).not.toContain("beta");
    expect(new Set(docked).size).toBe(docked.length);
    expect(new Set(docked)).toEqual(new Set(["alpha", "gamma"]));
  });
});

describe("the portal container", () => {
  function ScopedItem({ scope }: { scope: string | undefined }): ReactElement {
    // The scope is the ITEM's own (a provider between the bar and the item),
    // so it differs from the bar's region and must travel on the container.
    return (
      <Bar>
        <PortalForwardProvider name="data-theme-scope" value={scope}>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" />
          </AdaptiveBar.Item>
        </PortalForwardProvider>
      </Bar>
    );
  }

  it("carries the attributes that differ from the bar's, and updates them", () => {
    const { rerender } = render(<ScopedItem scope="alpha-scope" />);
    expect(containerOf("alpha").getAttribute("data-theme-scope")).toBe(
      "alpha-scope",
    );

    rerender(<ScopedItem scope="beta-scope" />);
    expect(containerOf("alpha").getAttribute("data-theme-scope")).toBe(
      "beta-scope",
    );
  });

  it("removes a forwarded key that disappears from the bag", () => {
    const { rerender } = render(<ScopedItem scope="alpha-scope" />);
    expect(containerOf("alpha").hasAttribute("data-theme-scope")).toBe(true);

    rerender(<ScopedItem scope={undefined} />);
    expect(containerOf("alpha").hasAttribute("data-theme-scope")).toBe(false);
  });

  it("leaves the bar's own attributes to the row and the panel's dock", () => {
    // Re-stamping the bar's scope on the container would make it a fresh
    // theme-scope root, resetting the text colour the row sets.
    render(
      <PortalForwardProvider name="data-theme-scope" value="bar-scope">
        <ThreeProbes />
      </PortalForwardProvider>,
    );
    expect(containerOf("alpha").hasAttribute("data-theme-scope")).toBe(false);
    const dock = document.querySelector("[role='dialog'] [data-theme-scope]");
    expect(dock?.getAttribute("data-theme-scope")).toBe("bar-scope");
  });
});

describe("the locks", () => {
  it("pins the item under an active pointer, and applies the move on release", () => {
    const { rerender } = render(<ThreeProbes />);
    const gamma = document.querySelector<HTMLElement>('[data-probe="gamma"]');
    expect(gamma).not.toBeNull();

    fireEvent.pointerDown(gamma!, { pointerId: 1 });
    available = 140;
    rerender(<ThreeProbes />);
    // Moving a widget out from under a live pointer releases pointer capture
    // and kills the gesture, so the bar re-fits around it instead.
    expect(isInline("gamma")).toBe(true);

    fireEvent.pointerUp(document, { pointerId: 1 });
    rerender(<ThreeProbes />);
    // Stored, not discarded: the release itself is what applies it.
    expect(isInline("gamma")).toBe(false);
  });

  it("pins an item whose own popup is open", () => {
    function PopupHolder(): ReactElement {
      useReportPopupOpen(true);
      return <Probe id="gamma" />;
    }
    function WithPopup(): ReactElement {
      return (
        <Bar>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="gamma">
            <PopupHolder />
          </AdaptiveBar.Item>
        </Bar>
      );
    }
    const { rerender } = render(<WithPopup />);
    available = 140;
    rerender(<WithPopup />);
    // An open popover lives in the top layer, and a re-parent drops it out of
    // it — so the popover would vanish the instant the row resized.
    expect(isInline("gamma")).toBe(true);
  });
});

describe("the always-mounted panel", () => {
  it("keeps the dock's identity and children across an open/close cycle", () => {
    const { rerender } = render(<ThreeProbes />);
    available = 140;
    rerender(<ThreeProbes />);
    expect(isInline("gamma")).toBe(false);

    const trigger = document.querySelector<HTMLElement>(
      "[data-adaptive-bar-trigger] button",
    );
    expect(trigger).not.toBeNull();

    const dock = containerOf("gamma").parentElement;
    expect(dock).not.toBeNull();
    const childrenBefore = [...dock!.children];

    fireEvent.click(trigger!);
    fireEvent.click(trigger!);

    // A `Popover`/`DropdownMenu` would have unmounted its content here and
    // orphaned every relocated container. "Closed" is CSS.
    expect(containerOf("gamma").parentElement).toBe(dock);
    expect([...dock!.children]).toEqual(childrenBefore);
    expect(mounts["gamma"]).toBe(1);
  });

  it("leaves nothing behind on document.body when the bar unmounts", () => {
    const { container, rerender, unmount } = render(<ThreeProbes />);
    available = 140;
    rerender(<ThreeProbes />);
    expect(isInline("gamma")).toBe(false);

    unmount();
    // The panel portals to `document.body` and the containers are nodes React
    // does not own, so nothing tidies them up on the way out except the item
    // host's own cleanup. (Testing Library's own render root is still attached
    // until `cleanup`; it is not ours and is excluded.)
    const strays = [...document.body.children].filter((el) => el !== container);
    expect(strays).toHaveLength(0);
    expect(document.querySelector("[data-adaptive-bar-item]")).toBeNull();
  });
});

describe("AdaptiveBar.Collapsed — the authored bucket", () => {
  function Bucket(): ReactElement {
    return (
      <AdaptiveBarMeasure measure={(el) => measureFake(el)}>
        <AdaptiveBar.Collapsed label="Overflow">
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="beta">
            <Probe id="beta" />
          </AdaptiveBar.Item>
        </AdaptiveBar.Collapsed>
      </AdaptiveBarMeasure>
    );
  }

  it("relocates every occupant regardless of width, and measures nothing", () => {
    // Membership is a decision the author already made in the layout config, so
    // there is nothing for a width to say about it — including at a width where
    // everything would comfortably fit.
    available = 100_000;
    render(<Bucket />);
    expect(isInline("alpha")).toBe(false);
    expect(isInline("beta")).toBe(false);
    expect(mounts["alpha"]).toBe(1);
    expect(mounts["beta"]).toBe(1);
  });

  it("keeps each occupant as itself unless it offered the row form", () => {
    render(<Bucket />);
    // The probe declares only `"compact"`, and `"compact"` is an INLINE rung —
    // out of the row it renders as itself. That is the difference from the
    // mechanism this replaces, which turned every member into a menu row.
    expect(formOf("alpha")).toBe("full");
  });
});

describe("docking through a display:contents wrapper chain", () => {
  /**
   * What sits between a bar and a contribution rendered through `.Render`:
   * `slot-render`'s box, and whatever `display: contents` wrappers a host
   * adds. `display: contents` removes a box from LAYOUT but not from the DOM
   * TREE — so the anchor is levels below the bar root while its container is
   * still, correctly, a flex item of the row.
   *
   * An inline `style` rather than a class because jsdom applies no stylesheet:
   * this way `getComputedStyle` reports `contents` for real, which is what the
   * production chain looks like to anything that asks.
   */
  function ContentsChain({ children }: { children: ReactNode }): ReactElement {
    return (
      <div style={{ display: "contents" }}>
        <div style={{ display: "contents" }}>{children}</div>
      </div>
    );
  }

  function WrappedProbes(): ReactElement {
    return (
      <Bar>
        {(["alpha", "beta", "gamma"] as const).map((id) => (
          <ContentsChain key={id}>
            <AdaptiveBar.Item id={id}>
              <Probe id={id} />
            </AdaptiveBar.Item>
          </ContentsChain>
        ))}
      </Bar>
    );
  }

  function anchorOf(id: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(
      `[data-adaptive-bar-anchor="${id}"]`,
    );
    if (el === null) throw new Error(`no anchor for bar item "${id}"`);
    return el;
  }

  function barRoot(): HTMLElement {
    const trigger = document.querySelector("[data-adaptive-bar-trigger]");
    const root = trigger?.parentElement ?? null;
    if (root === null) throw new Error("bar root not found");
    return root;
  }

  /**
   * How many occupant containers were re-parented while `run` ran.
   *
   * Counted at the DOM, not inferred: "a node already in the right place is
   * never touched" is the property every preserved focus, transition and scroll
   * offset hangs off, and it is exactly the property a docking rule that
   * compares against the wrong parent loses — silently, since the row still
   * looks right afterwards.
   *
   * `moveBefore` is absent from jsdom, so `relocateNode` takes the
   * `insertBefore` path and this sees every move. React never inserts these
   * containers itself: they are portal TARGETS, minted outside its tree.
   */
  function countDockMoves(run: () => void): number {
    const original = Node.prototype.insertBefore;
    let moves = 0;
    function counting<T extends Node>(
      this: Node,
      node: T,
      ref: Node | null,
    ): T {
      if (
        node instanceof HTMLElement &&
        node.hasAttribute("data-adaptive-bar-item")
      ) {
        moves += 1;
      }
      return original.call(this, node, ref) as T;
    }
    Node.prototype.insertBefore = counting;
    try {
      run();
    } finally {
      Node.prototype.insertBefore = original;
    }
    return moves;
  }

  it("docks each occupant at its own anchor, wherever the host put it", () => {
    render(<WrappedProbes />);

    for (const id of ["alpha", "beta", "gamma"]) {
      const container = containerOf(id);
      const anchor = anchorOf(id);
      // The invariant, stated at the DOM: immediately before its own anchor, in
      // the anchor's own parent — the innermost `contents` wrapper here, and NOT
      // the bar root, which is where docking used to insert unconditionally.
      expect(container.nextSibling).toBe(anchor);
      expect(container.parentElement).toBe(anchor.parentElement);
      expect(container.parentElement).not.toBe(barRoot());
    }
  });

  it("lays the occupants out in the host's own order", () => {
    render(<WrappedProbes />);
    const root = barRoot();
    const inOrder = [
      ...root.querySelectorAll<HTMLElement>("[data-adaptive-bar-item]"),
    ].map((el) => el.getAttribute("data-adaptive-bar-item"));
    // Document order across the whole subtree, which is what the row renders as
    // — the wrappers generate no boxes, so the containers are the row's flex
    // items in exactly this sequence.
    expect(inOrder).toEqual(["alpha", "beta", "gamma"]);
  });

  it("plans zero moves when nothing about the order changed", () => {
    const { rerender } = render(<WrappedProbes />);
    // A fresh `measure` arrow per render re-runs the whole measure-and-decide
    // pass (the ResizeObserver's job in a browser), so this is a real pass over
    // a row that simply has not changed.
    const moves = countDockMoves(() => {
      rerender(<WrappedProbes />);
    });
    expect(moves).toBe(0);
  });

  it("still relocates into the panel, and back, through the chain", () => {
    const { rerender } = render(<WrappedProbes />);
    const gammaInstance = instanceOf("gamma");
    expect(isInline("gamma")).toBe(true);

    available = 140;
    rerender(<WrappedProbes />);
    expect(isInline("gamma")).toBe(false);

    available = 1000;
    rerender(<WrappedProbes />);
    expect(isInline("gamma")).toBe(true);
    // Back at its anchor, not appended to the end of the row.
    expect(containerOf("gamma").nextSibling).toBe(anchorOf("gamma"));
    expect(mounts["gamma"]).toBe(1);
    expect(instanceOf("gamma")).toBe(gammaInstance);
  });
});

describe("absence", () => {
  it("treats a contribution that rendered nothing as absent, not as width zero", () => {
    function Empty(): ReactElement | null {
      useActionForm();
      return null;
    }
    function WithEmpty(): ReactElement {
      return (
        <Bar>
          <AdaptiveBar.Item id="alpha">
            <Probe id="alpha" />
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="ghost">
            <Empty />
          </AdaptiveBar.Item>
        </Bar>
      );
    }
    render(<WithEmpty />);
    // Hidden, so it is not a flex item at all: it costs no width AND no gap,
    // and it is never eligible for the panel.
    expect(containerOf("ghost").hidden).toBe(true);
    expect(containerOf("alpha").hidden).toBe(false);
    expect(isInline("ghost")).toBe(true);
  });
});
