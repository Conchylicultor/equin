import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BandSurface } from "../components/band-surface";
import {
  useDataViewControls,
  type DataViewControlsContextValue,
} from "../components/controls/controls-context";

/**
 * The band surface: the controls context reaches the band AND the aside (never
 * the body), the aside is a floating card beside an overlay band and a column
 * otherwise, and an overlay body is inset unless its view is full-bleed.
 */

const CONTROLS = {
  storageKey: "band-surface-test",
} as unknown as DataViewControlsContextValue;

function ReadsControls(props: { testId: string }) {
  const { storageKey } = useDataViewControls();
  return <div data-testid={props.testId}>{storageKey}</div>;
}

function renderSurface(opts: {
  overlay: boolean;
  aside?: boolean;
  fullBleed?: boolean;
}) {
  const insets: string[] = [];
  render(
    <BandSurface
      overlay={opts.overlay}
      aside={opts.aside ? <ReadsControls testId="aside" /> : undefined}
      fullBleed={opts.fullBleed ?? false}
      controls={CONTROLS}
      band={(asideInset) => {
        insets.push(asideInset);
        return <ReadsControls testId="band" />;
      }}
    >
      <div data-testid="body" />
    </BandSurface>,
  );
  return { insets };
}

afterEach(cleanup);

describe("BandSurface", () => {
  it("provides the controls to the band and the aside", () => {
    renderSurface({ overlay: false, aside: true });

    expect(screen.getByTestId("band").textContent).toBe("band-surface-test");
    expect(screen.getByTestId("aside").textContent).toBe("band-surface-test");
  });

  it("never provides the controls to the body", () => {
    function BodyReadsControls() {
      useDataViewControls();
      return null;
    }
    expect(() =>
      render(
        <BandSurface
          overlay={false}
          aside={undefined}
          fullBleed={false}
          controls={CONTROLS}
          band={() => null}
        >
          <BodyReadsControls />
        </BandSurface>,
      ),
    ).toThrow();
  });

  it("gives an in-flow band no aside inset (the aside has its own column)", () => {
    const { insets } = renderSurface({ overlay: false, aside: true });

    expect(insets.at(-1)).toBe("0px");
    expect(screen.getByTestId("aside").closest(".absolute")).toBeNull();
  });

  it("floats the aside beside an overlay band and insets the band past it", () => {
    const { insets } = renderSurface({ overlay: true, aside: true });

    expect(insets.at(-1)).toContain("calc(");
    const card = screen.getByTestId("aside").closest(".absolute");
    expect(card).not.toBeNull();
  });

  it("insets an overlay body by the band's height, unless the view is full-bleed", () => {
    renderSurface({ overlay: true });
    const inset = screen.getByTestId("body").parentElement!;
    expect(inset.style.paddingTop).toContain("--dv-header-offset");
    cleanup();

    renderSurface({ overlay: true, fullBleed: true });
    const bleed = screen.getByTestId("body").parentElement!;
    expect(bleed.style.paddingTop).toBe("");
    expect(bleed.className).toContain("h-full");
  });
});
