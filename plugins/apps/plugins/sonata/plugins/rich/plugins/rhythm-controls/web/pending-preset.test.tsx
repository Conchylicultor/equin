import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_PENDING_PRESET,
  setPendingPreset,
  usePendingPreset,
} from "./pending-preset";

function Probe({ songId }: { songId: string | null }) {
  const preset = usePendingPreset(songId);
  return <i>{preset === NO_PENDING_PRESET ? "none" : String(preset)}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the overlay as it
// stands: it must not throw.
describe("usePendingPreset under a server render", () => {
  it("reads no overlay for a song with no commit in flight", () => {
    expect(renderToStaticMarkup(<Probe songId="quiet" />)).toBe("<i>none</i>");
    expect(renderToStaticMarkup(<Probe songId={null} />)).toBe("<i>none</i>");
  });

  it("reads the id a commit sent", () => {
    setPendingPreset("song-1", "swing");
    expect(renderToStaticMarkup(<Probe songId="song-1" />)).toBe(
      "<i>swing</i>",
    );
  });
});
