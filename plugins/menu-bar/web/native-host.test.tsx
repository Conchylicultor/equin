import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useNativeApps } from "./native-apps";
import { useNativeHost } from "./native-host";

// A static render to HTML (react-dom/server, no window) is hosted by no
// helper: the host is absent — read without touching window — and so the
// installed apps are unavailable.
describe("native host under a server render", () => {
  it("answers absent, and no apps", () => {
    function Probe() {
      return <i>{`${useNativeHost().kind},${useNativeApps().kind}`}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>absent,unavailable</i>");
  });
});
