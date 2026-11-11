import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useThemeSelections } from "./theme-selections";

// A static render to HTML (react-dom/server, no DOM) runs no collector's
// layout effect: no scope has reported, so the selections are still pending —
// never an empty list standing in for them.
describe("useThemeSelections under a server render", () => {
  it("answers pending", () => {
    function Probe() {
      return <i>{String(useThemeSelections().pending)}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>true</i>");
  });
});
