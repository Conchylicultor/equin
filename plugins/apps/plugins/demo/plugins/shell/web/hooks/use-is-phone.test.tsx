import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useIsPhone } from "./use-is-phone";

// A static render to HTML (react-dom/server, no window) has no screen to ask:
// whether it is a phone is unknown, never guessed.
describe("useIsPhone under a server render", () => {
  it("answers unknown, without touching window", () => {
    function Probe() {
      return <i>{String(useIsPhone())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>null</i>");
  });
});
