import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useElectedHost } from "./host-election";

// A static render to HTML (react-dom/server) runs no effect, so no host
// registers: the election holds no one, and this host does not run.
describe("useElectedHost under a server render", () => {
  it("answers not elected", () => {
    function Probe() {
      return <i>{String(useElectedHost("probe"))}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
