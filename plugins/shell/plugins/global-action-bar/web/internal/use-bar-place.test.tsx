import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useViewportSize } from "./use-bar-place";

// A static render to HTML (react-dom/server, no window) has no viewport: its
// size is unknown, never a made-up one.
describe("useViewportSize under a server render", () => {
  it("answers no viewport, without touching window", () => {
    function Probe() {
      const v = useViewportSize();
      return <i>{v === null ? "unknown" : `${v.w}x${v.h}`}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>unknown</i>");
  });
});
