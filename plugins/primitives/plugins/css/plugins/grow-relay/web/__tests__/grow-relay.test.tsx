import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { GrowRelay, useRequestGrow } from "../index";

/**
 * The invariant under test: a widget that needs its row's slack says so from
 * where it is rendered, and every box between it and its row learns — with no
 * flag declared anywhere. That is the whole reason this primitive exists: the
 * declaration it replaces sat two or three files from the widget it was about,
 * and both consumers in the repo forgot it once each.
 */

/** The widget: asks, and prints what it got back. */
function Asker({ active = true }: { active?: boolean }) {
  const grant = useRequestGrow(active);
  return (
    <>
      <span data-testid="granted">{String(grant.granted)}</span>
      <span data-testid="relays">{String(grant.relays)}</span>
    </>
  );
}

/** A relay box, tagged so the test can read whether it grew. */
function Box({
  name,
  active,
  children,
}: {
  name: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <GrowRelay active={active}>
      {(growing) => (
        <div data-testid={name} data-growing={String(growing)}>
          {children}
        </div>
      )}
    </GrowRelay>
  );
}

afterEach(cleanup);

const grew = (el: HTMLElement) => el.getAttribute("data-growing");

describe("the ask travels", () => {
  it("grows the box it is rendered in, with nothing declared", () => {
    const { getByTestId } = render(
      <Box name="cell">
        <Asker />
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
  });

  it("grows EVERY box in between, not only the nearest", () => {
    // The shape that broke in production: cell → Fill → wrapper → bar. Growing
    // only the nearest box leaves the next one shrink-wrapping, which hands the
    // bar its own content back as the width it was given.
    const { getByTestId } = render(
      <Box name="cell">
        <Box name="fill">
          <Box name="wrapper">
            <Asker />
          </Box>
        </Box>
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(grew(getByTestId("fill"))).toBe("true");
    expect(grew(getByTestId("wrapper"))).toBe("true");
  });

  it("leaves a box with nothing asking under it rigid", () => {
    const { getByTestId } = render(
      <Box name="cell">
        <span>a rigid button</span>
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("false");
  });

  it("passes straight through a box that is not a relay", () => {
    // Context crosses a plain wrapper, so the bookkeeping survives one. That
    // wrapper still fails to grow ITSELF — which no bookkeeping can fix, and
    // which is what the requester's own runtime probe is for.
    const { getByTestId } = render(
      <Box name="cell">
        <div>
          <Asker />
        </div>
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
  });
});

describe("an inactive relay", () => {
  it("is transparent: the box above grows, it does not, and it is not counted", () => {
    const { getByTestId } = render(
      <Box name="cell">
        <Box name="contents" active={false}>
          <Asker />
        </Box>
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(grew(getByTestId("contents"))).toBe("false");
    expect(getByTestId("relays").textContent).toBe("1");
  });

  it("moves the ask when it flips, remounting nothing under it", () => {
    let mounts = 0;
    function Counted() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <Asker />;
    }
    const tree = (active: boolean) => (
      <Box name="cell">
        <Box name="flip" active={active}>
          <Counted />
        </Box>
      </Box>
    );
    const { getByTestId, rerender } = render(tree(false));
    expect(grew(getByTestId("flip"))).toBe("false");
    rerender(tree(true));
    expect(grew(getByTestId("flip"))).toBe("true");
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(getByTestId("relays").textContent).toBe("2");
    rerender(tree(false));
    expect(grew(getByTestId("flip"))).toBe("false");
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(mounts).toBe(1);
  });
});

describe("the ask stops", () => {
  it("stops at a Stop, leaving boxes above it untouched", () => {
    const { getByTestId } = render(
      <Box name="outer">
        <GrowRelay.Stop>
          <Box name="inner">
            <Asker />
          </Box>
        </GrowRelay.Stop>
      </Box>,
    );
    expect(grew(getByTestId("inner"))).toBe("true");
    expect(grew(getByTestId("outer"))).toBe("false");
  });

  it("asks for nothing when inactive", () => {
    // `AdaptiveBar.Collapsed` is one rigid `⋯`: it holds no slack and must not
    // take its row's.
    const { getByTestId } = render(
      <Box name="cell">
        <Asker active={false} />
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("false");
    expect(getByTestId("relays").textContent).toBe("0");
  });
});

describe("release", () => {
  it("releases when the asker unmounts", () => {
    const { getByTestId, rerender } = render(
      <Box name="cell">
        <Asker />
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    rerender(<Box name="cell">{null}</Box>);
    expect(grew(getByTestId("cell"))).toBe("false");
  });

  it("holds until BOTH askers are gone", () => {
    const two = (
      <Box name="cell">
        <Asker />
        <Asker />
      </Box>
    );
    const { getByTestId, rerender } = render(two);
    expect(grew(getByTestId("cell"))).toBe("true");
    rerender(
      <Box name="cell">
        <Asker />
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    rerender(<Box name="cell">{null}</Box>);
    expect(grew(getByTestId("cell"))).toBe("false");
  });

  it("never remounts what asked, so a relay cannot loop", () => {
    // The one way to hang a page with this API: a consumer that swaps the
    // ELEMENT on `growing` unmounts the asker, which releases the ask, which
    // un-grows the box, which mounts it back. Growing is a styling answer, and
    // this pins that the primitive itself never re-keys its subtree.
    let mounts = 0;
    function CountedAsker() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <Asker />;
    }
    const { getByTestId } = render(
      <Box name="cell">
        <CountedAsker />
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(mounts).toBe(1);
  });

  it("settles instead of flickering when the count flips", () => {
    // The reason the sink is a separate, permanently stable context from the grant: if
    // the registration handle changed identity when the count did, every
    // descendant's effect would re-run and its cleanup would take the count
    // straight back down. A settled `true` here is that proof.
    const { getByTestId } = render(
      <Box name="a">
        <Box name="b">
          <Asker />
        </Box>
      </Box>,
    );
    expect(grew(getByTestId("a"))).toBe("true");
    expect(grew(getByTestId("b"))).toBe("true");
  });
});

describe("the acknowledgement", () => {
  it("is granted on the spot when there is no relay at all", () => {
    // A bar rendered straight into its row (a pane header) waits for nobody.
    const { getByTestId } = render(<Asker />);
    expect(getByTestId("granted").textContent).toBe("true");
    expect(getByTestId("relays").textContent).toBe("0");
  });

  it("counts every relay that claimed the ask", () => {
    const { getByTestId } = render(
      <Box name="cell">
        <Box name="wrapper">
          <Asker />
        </Box>
      </Box>,
    );
    expect(getByTestId("relays").textContent).toBe("2");
    expect(getByTestId("granted").textContent).toBe("true");
  });

  it("is granted only once the WHOLE chain has applied the grow", () => {
    // Not "the nearest relay said yes": a requester that measures in a layout
    // effect would otherwise judge a box whose ancestors have not grown yet.
    const { getByTestId } = render(
      <Box name="cell">
        <Box name="wrapper">
          <Asker />
        </Box>
      </Box>,
    );
    expect(grew(getByTestId("cell"))).toBe("true");
    expect(grew(getByTestId("wrapper"))).toBe("true");
    expect(getByTestId("granted").textContent).toBe("true");
  });
});
