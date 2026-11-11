import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { Loading } from "../internal/loading";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

// A static render (HTML for robots, never hydrated) would ship a loading state
// as the page's content: it throws instead, naming what was loading.
describe("a loading state in a static render", () => {
  it("throws, naming the variant and its label", () => {
    expect(() =>
      renderToStaticMarkup(<Loading variant="spinner" label="Loading notes" />),
    ).toThrow(
      /<Loading variant="spinner"> \("Loading notes"\) rendered in a static render/,
    );
  });

  it("every variant, a label or not", () => {
    for (const variant of ["text", "rows", "cards", "block"] as const)
      expect(() => renderToStaticMarkup(<Loading variant={variant} />)).toThrow(
        /StaticLoadingError|rendered in a static render/,
      );
  });
});
