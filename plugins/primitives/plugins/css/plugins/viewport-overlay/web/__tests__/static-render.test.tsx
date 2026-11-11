import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { ViewportOverlay } from "../internal/viewport-overlay";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

afterEach(() => {
  vi.unstubAllGlobals();
});

// A static render (HTML for robots, never hydrated) has no `document.body` to
// portal into, and what floats over the viewport is not the page's content.
describe("a viewport overlay in a static render", () => {
  it("draws nothing, without touching the DOM", () => {
    vi.stubGlobal("document", undefined);
    const html = renderToStaticMarkup(
      <main>
        <p>Page</p>
        <ViewportOverlay className="bg-black/70">
          <p>Scrim content</p>
        </ViewportOverlay>
      </main>,
    );
    expect(html).toBe("<main><p>Page</p></main>");
  });
});
