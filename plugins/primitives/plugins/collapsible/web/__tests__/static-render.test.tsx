import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FoldMotion,
} from "../internal/collapsible";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

// A static render (HTML for robots, never hydrated) has no click to open a
// fold, so a closed fold's content is written into the markup, hidden.
describe("a closed collapsible in a static render", () => {
  it("keeps its content in the markup, hidden", () => {
    const html = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent>The folded-away text</CollapsibleContent>
      </Collapsible>,
    );
    expect(html).toContain("The folded-away text");
    const box = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector('[data-slot="collapsible-content"]');
    expect(box?.hasAttribute("hidden")).toBe(true);
    expect(box?.getAttribute("data-state")).toBe("closed");
  });

  it("FoldMotion too, and an open fold is not hidden", () => {
    const closed = renderToStaticMarkup(
      <FoldMotion open={false}>closed text</FoldMotion>,
    );
    expect(closed).toContain("closed text");
    expect(closed).toContain("hidden");
    const open = renderToStaticMarkup(
      <FoldMotion open={true}>open text</FoldMotion>,
    );
    expect(open).toContain("open text");
    expect(open).not.toContain("hidden");
  });

  it("a closed state fold is left out, as live; an open one is written", () => {
    const closed = renderToStaticMarkup(
      <FoldMotion open={false} kind="state">
        Message sent
      </FoldMotion>,
    );
    expect(closed).toBe("");
    const open = renderToStaticMarkup(
      <FoldMotion open={true} kind="state">
        The form
      </FoldMotion>,
    );
    expect(open).toContain("The form");
    expect(open).not.toContain("hidden");
  });
});
