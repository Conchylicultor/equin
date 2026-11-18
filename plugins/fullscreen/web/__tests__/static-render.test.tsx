import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { FullscreenButton } from "../components/fullscreen-toggle";

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

describe("the fullscreen button in a static render", () => {
  it("offers no button, without touching the DOM", () => {
    noDom();
    // A static render can request nothing, so it reads fullscreen as unsupported.
    expect(renderToStaticMarkup(<FullscreenButton />)).toBe("");
  });
});
