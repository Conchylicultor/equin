import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { SurfaceOverlay } from "../internal/surface-overlay";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A static render has no DOM. */
function noDom(): void {
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("document", undefined);
}

// What floats over the surface is not page content, and there is no document
// to mint the portal container in.
describe("a surface overlay in a static render", () => {
  it("draws nothing, without touching the DOM", () => {
    noDom();
    const html = renderToStaticMarkup(
      <main>
        <p>Page</p>
        <SurfaceOverlay>
          <p>Overlay</p>
        </SurfaceOverlay>
      </main>,
    );
    expect(html).toBe("<main><p>Page</p></main>");
  });
});
