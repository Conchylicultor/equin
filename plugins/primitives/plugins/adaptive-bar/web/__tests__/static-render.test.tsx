import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { AdaptiveBar } from "../internal/adaptive-bar";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

// A static render (HTML for robots, never hydrated) runs with no DOM: hide
// jsdom's for the render, so a building block that reads one fails here.
afterEach(() => {
  vi.unstubAllGlobals();
});
function withoutDom<T>(render: () => T): T {
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("HTMLElement", undefined);
  vi.stubGlobal("MutationObserver", undefined);
  vi.stubGlobal("ResizeObserver", undefined);
  return render();
}

describe("an adaptive bar in a static render", () => {
  it("writes every item in place, in order, at full form", () => {
    const html = withoutDom(() =>
      renderToStaticMarkup(
        <AdaptiveBar label="More actions">
          <AdaptiveBar.Yield>Title</AdaptiveBar.Yield>
          <AdaptiveBar.Item id="a" className="extra">
            <button type="button">Alpha</button>
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="b">
            <button type="button">Beta</button>
          </AdaptiveBar.Item>
          <AdaptiveBar.Item id="c">
            <button type="button">Gamma</button>
          </AdaptiveBar.Item>
        </AdaptiveBar>,
      ),
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = [...doc.querySelectorAll("[data-adaptive-bar-item]")];
    expect(
      items.map((el) => el.getAttribute("data-adaptive-bar-item")),
    ).toEqual(["a", "b", "c"]);
    expect(items.map((el) => el.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(items[0]!.classList.contains("extra")).toBe(true);
    // All inside the bar's own row, after the title.
    const root = doc.querySelector("[data-adaptive-bar-root]");
    expect(root?.textContent).toBe("TitleAlphaBetaGamma");
  });

  it("the collapsed bucket writes its items in place too", () => {
    const html = withoutDom(() =>
      renderToStaticMarkup(
        <AdaptiveBar.Collapsed label="More">
          <AdaptiveBar.Item id="x">
            <span>Hidden away</span>
          </AdaptiveBar.Item>
        </AdaptiveBar.Collapsed>,
      ),
    );
    expect(html).toContain("Hidden away");
  });
});
