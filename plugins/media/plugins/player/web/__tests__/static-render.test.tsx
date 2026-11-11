import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import { MediaPlayer } from "../components/media-player";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

// A static render (HTML for robots, never hydrated) runs with no DOM: hide
// jsdom's for the render, so a building block that reads one fails here.
afterEach(() => {
  vi.unstubAllGlobals();
});
function withoutDom<T>(render: () => T): T {
  vi.stubGlobal("document", undefined);
  vi.stubGlobal("HTMLElement", undefined);
  vi.stubGlobal("HTMLVideoElement", undefined);
  vi.stubGlobal("MutationObserver", undefined);
  vi.stubGlobal("ResizeObserver", undefined);
  return render();
}

describe("a media player in a static render", () => {
  it("writes the media in place, captioned by its label, with no controls", () => {
    const html = withoutDom(() =>
      renderToStaticMarkup(
        <MediaPlayer
          kind="video"
          src="clip.mp4"
          label="The clip"
          poster="poster.png"
        />,
      ),
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const host = doc.querySelector(".mp-slot > .mp-host");
    expect(host).not.toBeNull();
    const video = host!.querySelector("video");
    expect(video?.getAttribute("src")).toBe("clip.mp4");
    expect(video?.getAttribute("poster")).toBe("poster.png");
    expect(video?.getAttribute("aria-label")).toBe("The clip");
    expect(host!.querySelector("figcaption")?.textContent).toBe("The clip");
    // No controls: no button, no slider, and no time readout — the state of
    // a playback that never happens in HTML nobody hydrates.
    expect(doc.querySelectorAll("button, input, [role=slider]")).toHaveLength(
      0,
    );
    expect(doc.body.textContent).toBe("The clip");
  });

  it("an audio player too", () => {
    const html = withoutDom(() =>
      renderToStaticMarkup(
        <MediaPlayer kind="audio" src="song.mp3" label="Song" />,
      ),
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("audio")?.getAttribute("src")).toBe("song.mp3");
    expect(doc.body.textContent).toBe("Song");
  });
});
