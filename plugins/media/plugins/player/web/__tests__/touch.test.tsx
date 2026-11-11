import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { WithShortcuts } from "@plugins/primitives/plugins/shortcuts/web/testing";
import { MediaPlayer } from "../components/media-player";
import { DOUBLE_TAP_MS, TOUCH_QUERY } from "../internal/geometry";
import { installMediaStub, stubRect } from "./media-stub";

let media: ReturnType<typeof installMediaStub>;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  media = installMediaStub();
  // A phone: the touch query matches.
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    ...realMatchMedia(query),
    matches: query === TOUCH_QUERY,
  }));
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  render(
    <WithShortcuts>
      <MediaPlayer kind="video" src="clip.mp4" label="Clip" />
    </WithShortcuts>,
  );
  const root = document.querySelector<HTMLElement>("[data-media-player]")!;
  const video = root.querySelector("video")!;
  const surface = root.querySelector<HTMLElement>(".mp-t-surface")!;
  stubRect(surface, 0, 400);
  const chrome = root.querySelector<HTMLElement>(".mp-t-chrome")!;
  const tap = (x: number) => fireEvent.click(surface, { clientX: x });
  const wait = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  return { root, video, chrome, tap, wait };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll("button")).find(
    (x) => x.getAttribute("aria-label") === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

describe("touch controls", () => {
  it("draw the touch layout, not the pill", () => {
    const { root } = setup();
    expect(root.hasAttribute("data-touch")).toBe(true);
    expect(root.querySelector(".mp-pill")).toBeNull();
    button(root, "Back 10 seconds");
    button(root, "Forward 10 seconds");
  });

  it("a tap shows or hides the controls and never plays", () => {
    const { root, chrome, tap, wait } = setup();
    fireEvent.click(button(root, "Play"));
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(chrome.hasAttribute("data-shown")).toBe(true);
    tap(200);
    wait(0);
    expect(chrome.hasAttribute("data-shown")).toBe(false);
    tap(200);
    wait(0);
    expect(chrome.hasAttribute("data-shown")).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(media.pause).not.toHaveBeenCalled();
  });

  it("paused, the controls stay up", () => {
    const { chrome, tap, wait } = setup();
    tap(200);
    wait(5000);
    expect(chrome.hasAttribute("data-shown")).toBe(true);
  });

  it("a double-tap on a side seeks 10 s; a further tap 10 s more", () => {
    const { video, tap, wait } = setup();
    video.currentTime = 30;
    tap(380);
    tap(380);
    expect(video.currentTime).toBe(40);
    tap(380);
    expect(video.currentTime).toBe(50);
    tap(10);
    wait(DOUBLE_TAP_MS);
    tap(10);
    expect(video.currentTime).toBe(50);
    tap(10);
    expect(video.currentTime).toBe(40);
  });

  it("full screen fills the window where the browser cannot", () => {
    const { root } = setup();
    fireEvent.click(button(root, "Full screen"));
    expect(root.hasAttribute("data-filling")).toBe(true);
    fireEvent.click(button(root, "Exit full screen"));
    expect(root.hasAttribute("data-filling")).toBe(false);
  });

  it("settings open as a sheet without key caps", () => {
    const { root } = setup();
    fireEvent.click(button(root, "Settings"));
    const sheet = root.querySelector<HTMLElement>("[role=dialog]")!;
    expect(sheet.hasAttribute("data-sheet")).toBe(true);
    expect(sheet.hasAttribute("data-open")).toBe(true);
    expect(sheet.querySelector("kbd")).toBeNull();
  });
});
