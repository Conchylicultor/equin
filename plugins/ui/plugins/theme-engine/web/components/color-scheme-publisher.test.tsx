import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { usePreview, usePreviewColorScheme } from "./color-scheme-publisher";

// A static render to HTML (react-dom/server, no DOM) runs no insertion
// effect: no preview is mounted, so the scope wears its own scheme.
describe("usePreview under a server render", () => {
  it("answers no preview, even beside a previewing component", () => {
    function Probe() {
      usePreviewColorScheme("app", "dark");
      return <i>{usePreview("app") ?? "none"}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>none</i>");
  });
});
