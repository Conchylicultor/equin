import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  usePortalForwardedAttrs,
  useRegionForwardedAttrs,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  appThemeScope,
  subThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "../internal/theme";

/**
 * What a sub-theme boundary hands to portaled content below it. A popup opened
 * from inside a sub-theme wears the theme around it (the website's Improve
 * panel is ordinary UI, not more page), while content that is portaled but
 * still part of the region — an adaptive bar's items, which always render
 * through a portal — keeps the sub-theme. Getting the second half wrong shrinks
 * a page's header items back to UI size whenever the app's scope block is
 * painted.
 */

afterEach(cleanup);

const reading = { kind: "sub-theme", id: "reading" } as const;

function Probe() {
  const popup = usePortalForwardedAttrs()["data-theme-scope"];
  const region = useRegionForwardedAttrs()["data-theme-scope"];
  return (
    <>
      <span data-testid="popup">{popup ?? "none"}</span>
      <span data-testid="region">{region ?? "none"}</span>
    </>
  );
}

describe("a sub-theme boundary", () => {
  it("stamps its own token on the element", () => {
    const { getByTestId } = render(
      <Theme name={subThemeScope(reading)} surface="none" data-testid="box">
        <span />
      </Theme>,
    );
    expect(getByTestId("box").getAttribute("data-theme-scope")).toBe(
      "sub:reading",
    );
  });

  it("forwards itself to region content, and the enclosing theme to popups", () => {
    const { getByTestId } = render(
      <Theme name={appThemeScope("site")} surface="canvas">
        <Theme name={subThemeScope(reading)} surface="none">
          <Probe />
        </Theme>
      </Theme>,
    );
    expect(getByTestId("region").textContent).toBe("sub:reading");
    expect(getByTestId("popup").textContent).toBe("app:site");
  });

  it("forwards no scope to popups when nothing encloses it", () => {
    const { getByTestId } = render(
      <Theme name={subThemeScope(reading)} surface="none">
        <Probe />
      </Theme>,
    );
    expect(getByTestId("region").textContent).toBe("sub:reading");
    expect(getByTestId("popup").textContent).toBe("none");
  });

  it("is reset by a whole-theme boundary inside it, for both kinds of content", () => {
    const { getByTestId } = render(
      <Theme name={subThemeScope(reading)} surface="none">
        <Theme name={appThemeScope("guest")} surface="canvas">
          <Probe />
        </Theme>
      </Theme>,
    );
    expect(getByTestId("region").textContent).toBe("app:guest");
    expect(getByTestId("popup").textContent).toBe("app:guest");
  });
});
