import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useViewportAtMost } from "./use-viewport-at-most";

// A static render to HTML (react-dom/server, no DOM) has no viewport: no
// breakpoint is known, and `window` is never read.
describe("useViewportAtMost under a server render", () => {
  it("answers unknown", () => {
    function Probe() {
      return <i>{String(useViewportAtMost(640))}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>null</i>");
  });
});
