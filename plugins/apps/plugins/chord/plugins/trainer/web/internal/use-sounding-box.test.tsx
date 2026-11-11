import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { YouTubePlayerController } from "@plugins/integrations/plugins/youtube/web";
import type { Box, Round } from "../../core";
import { useSoundingBox } from "./use-sounding-box";

// The hook reads the player's playhead and the round's boxes only.
const player = {
  subscribePlayhead: () => () => {},
  getPlayhead: () => 2.5,
} as unknown as YouTubePlayerController;
const box = (position: number, startSec: number, endSec: number) =>
  ({ position, startSec, endSec }) as Box;
const round = { boxes: [box(0, 0, 2), box(1, 2, 4)] } as unknown as Round;

// A static render to HTML (react-dom/server, no DOM) reads the playhead as
// the player holds it now.
describe("useSoundingBox under a server render", () => {
  it("answers the box under the playhead while watched", () => {
    function Probe({ active }: { active: boolean }) {
      return <i>{String(useSoundingBox(player, round, active))}</i>;
    }
    expect(renderToStaticMarkup(<Probe active />)).toBe("<i>1</i>");
    expect(renderToStaticMarkup(<Probe active={false} />)).toBe("<i>null</i>");
  });
});
