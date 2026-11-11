import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useConfigPreview } from "./config-preview";

// A static render to HTML (react-dom/server, no DOM, no session storage)
// belongs to no tab: no tab's git-defaults preview applies.
describe("useConfigPreview under a server render", () => {
  it("reads no preview, without touching session storage", () => {
    function Probe() {
      return <i>{String(useConfigPreview())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
