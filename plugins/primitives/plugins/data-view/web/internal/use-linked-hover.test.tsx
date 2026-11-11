import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createLinkedHover, type LinkedHover } from "../../core";
import { useHoveredId, useIsHovered } from "./use-linked-hover";

function Probe({ hover }: { hover: LinkedHover | null }) {
  const id = useHoveredId(hover);
  const a = useIsHovered(hover, "a");
  return <i>{`${String(id)},${String(a)}`}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the hover store as
// it stands: it must not throw.
describe("linked hover under a server render", () => {
  it("reads nothing hovered without a store", () => {
    expect(renderToStaticMarkup(<Probe hover={null} />)).toBe(
      "<i>null,false</i>",
    );
  });

  it("reads the id a store holds", () => {
    const hover = createLinkedHover();
    hover.report("a", true);
    expect(renderToStaticMarkup(<Probe hover={hover} />)).toBe("<i>a,true</i>");
  });
});
