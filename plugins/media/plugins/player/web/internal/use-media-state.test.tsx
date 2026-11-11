import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useMediaState, useMediaTime } from "./use-media-state";

// A static render to HTML (react-dom/server, no DOM) mounts no element: both
// snapshots answer their initial values, as before an element appears.
describe("media snapshots under a server render", () => {
  it("answer the initial state and time", () => {
    function Probe() {
      const s = useMediaState(null);
      const t = useMediaTime(null);
      return (
        <i>
          {[s.paused, s.volume, s.muted, t.currentTime, t.buffered].join(",")}
        </i>
      );
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>true,1,false,0,0</i>");
  });
});
