import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useWindowSize } from "./use-window-size";

// A static render to HTML (react-dom/server, no DOM) has no window: its size
// is not known, and `window` is never read.
describe("useWindowSize under a server render", () => {
  it("answers unknown", () => {
    function Probe() {
      return <i>{JSON.stringify(useWindowSize())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>null</i>");
  });
});
