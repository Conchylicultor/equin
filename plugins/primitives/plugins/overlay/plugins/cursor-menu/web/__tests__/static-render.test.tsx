import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { CursorAnchoredMenu } from "../internal/cursor-anchored-menu";

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

// No click can open a menu in HTML nobody hydrates, and there is no
// document.body to pin its trigger in.
describe("a cursor-anchored menu in a static render", () => {
  it("draws nothing, without touching the DOM", () => {
    noDom();
    const html = renderToStaticMarkup(
      <main>
        <CursorAnchoredMenu anchor={{ x: 1, y: 2 }} onClose={() => undefined}>
          <p>Item</p>
        </CursorAnchoredMenu>
      </main>,
    );
    expect(html).toBe("<main></main>");
  });
});
