import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import {
  NoStaticValueError,
  useBrowserValue,
  useMediaQuery,
  useOwnedElement,
  useViewportSize,
} from "../internal/browser-value";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A static render has no DOM: every read must go through the static value. */
function noDom(): void {
  vi.stubGlobal("window", undefined);
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("matchMedia", undefined);
}

const readTitle = (): string => document.title;

describe("browser values in a static render", () => {
  it("draws the static value, never reading the browser", () => {
    noDom();
    function C() {
      const title = useBrowserValue({
        name: "title",
        read: readTitle,
        staticValue: "none",
      });
      const dark = useMediaQuery("(prefers-color-scheme: dark)", false);
      const size = useViewportSize({ width: 3, height: 4 });
      return <p>{`${title} ${dark} ${size.width}x${size.height}`}</p>;
    }
    expect(renderToStaticMarkup(<C />)).toBe("<p>none false 3x4</p>");
  });

  it("fails loudly, naming the value, when it has no static form", () => {
    noDom();
    function C() {
      return <p>{useBrowserValue({ name: "the title", read: readTitle })}</p>;
    }
    expect(() => renderToStaticMarkup(<C />)).toThrow(NoStaticValueError);
    expect(() => renderToStaticMarkup(<C />)).toThrow('"the title"');
  });

  it("an owned element has no static form", () => {
    noDom();
    function C() {
      useOwnedElement("the stage", (doc) => doc.createElement("div"));
      return null;
    }
    expect(() => renderToStaticMarkup(<C />)).toThrow('"the stage"');
  });
});
