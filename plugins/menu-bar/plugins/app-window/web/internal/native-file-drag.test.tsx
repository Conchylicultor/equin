import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useNativeFileDrag } from "./native-file-drag";

// A static render to HTML (react-dom/server, no window) is no app window: it
// has no native file drag — read without touching window.
describe("useNativeFileDrag under a server render", () => {
  it("answers none", () => {
    function Probe() {
      return <i>{useNativeFileDrag() === null ? "none" : "drag"}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>none</i>");
  });
});
