import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { useColorScheme } from "../internal/color-scheme";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

afterEach(() => {
  vi.unstubAllGlobals();
});

// The website's pages are statically rendered: outside every boundary, with no
// scheme published yet, the root's scheme is read without an `<html>` to ask.
describe("the colour scheme in a static render", () => {
  it("is light outside every boundary, without touching the DOM", () => {
    vi.stubGlobal("document", undefined);
    function Probe() {
      return <p>{useColorScheme()}</p>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>light</p>");
  });
});
