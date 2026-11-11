import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  useYouTubePlayer,
  useYouTubePlayerState,
  useYouTubePlayhead,
} from "./hooks";

// A static render to HTML (react-dom/server, no DOM) binds no iframe: the
// controller's snapshots answer what they hold — still loading, no playhead.
describe("player snapshots under a server render", () => {
  it("answer the controller's own state and playhead", () => {
    function Probe() {
      const player = useYouTubePlayer();
      const state = useYouTubePlayerState(player);
      const active = useYouTubePlayhead(player, true);
      const inactive = useYouTubePlayhead(player, false);
      return <i>{[state.kind, String(active), String(inactive)].join(",")}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>loading,null,null</i>");
  });
});
