import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { WithShortcuts } from "@plugins/primitives/plugins/shortcuts/web/testing";
import { MediaPlayer, type MediaPlayerProps } from "../components/media-player";
import { DIAL_PX_PER_STEP } from "../internal/math";
import { DURATION, installMediaStub, stubRect } from "./media-stub";

let media: ReturnType<typeof installMediaStub>;

beforeEach(() => {
  media = installMediaStub();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "documentPictureInPicture");
});

function setup(props: Partial<MediaPlayerProps> = {}) {
  const r = render(
    <WithShortcuts>
      <button type="button" data-testid="outside">
        outside
      </button>
      <MediaPlayer kind="video" src="clip.mp4" label="Clip" {...props} />
    </WithShortcuts>,
  );
  const root = document.querySelector<HTMLElement>("[data-media-player]")!;
  const video = root.querySelector("video")!;
  const q = <T extends Element = HTMLElement>(s: string) =>
    root.querySelector<T>(s)!;
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  return { ...r, root, video, q, key };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const b = Array.from(root.querySelectorAll("button")).find(
    (x) => x.getAttribute("aria-label") === label,
  );
  if (!b) throw new Error(`no button "${label}"`);
  return b;
}

describe("play / pause", () => {
  it("the play button plays and pauses", () => {
    const { root, video } = setup();
    fireEvent.click(button(root, "Play"));
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
    fireEvent.click(button(root, "Pause"));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(true);
  });

  it("the big play button shows until the first play, not on a later pause", () => {
    const { root } = setup();
    expect(root.hasAttribute("data-unplayed")).toBe(true);
    fireEvent.click(button(root, "Play"));
    fireEvent.click(button(root, "Pause"));
    expect(root.hasAttribute("data-paused")).toBe(true);
    expect(root.hasAttribute("data-unplayed")).toBe(false);
  });

  it("Space toggles once from outside the player", () => {
    const { getByTestId, key } = setup();
    key(getByTestId("outside"), " ");
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("Space on the player's own focused button is that button's alone", () => {
    const { root, key } = setup();
    const play = button(root, "Play");
    play.focus();
    // The shortcut yields: the button activates itself on Space (its click),
    // so a toggle here too would play and pause in one press.
    key(play, " ");
    expect(media.play).not.toHaveBeenCalled();
    fireEvent.click(play);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("Space on a button focused by a click plays / pauses (and does not press it)", () => {
    const { root } = setup();
    const full = button(root, "Full screen");
    full.focus();
    document.documentElement.dataset.inputModality = "pointer";
    try {
      const down = new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        full.dispatchEvent(down);
      });
      expect(media.play).toHaveBeenCalledTimes(1);
      // Cancelled, so the browser never activates the focused button.
      expect(down.defaultPrevented).toBe(true);
    } finally {
      delete document.documentElement.dataset.inputModality;
    }
  });

  it("K toggles; arrows skip 5 s; digits jump", () => {
    const { root, video, key } = setup();
    key(root, "k");
    expect(media.play).toHaveBeenCalledTimes(1);
    act(() => {
      video.currentTime = 30;
    });
    key(root, "ArrowLeft");
    expect(video.currentTime).toBe(25);
    key(root, "ArrowRight");
    key(root, "ArrowRight");
    expect(video.currentTime).toBe(35);
    key(root, "3");
    expect(video.currentTime).toBe(18);
  });

  it("arrows skip 5 s of watching: scaled by the speed", () => {
    const { root, video, key } = setup();
    act(() => {
      video.currentTime = 30;
    });
    // < twice: 1× → 0.5×, so a press skips 2.5 s of the media.
    key(root, "<", { shiftKey: true });
    key(root, "<", { shiftKey: true });
    expect(video.playbackRate).toBe(0.5);
    key(root, "ArrowLeft");
    expect(video.currentTime).toBe(27.5);
  });
});

describe("seek bar", () => {
  it("a press seeks to the point, a drag follows, playback resumes after", () => {
    const { root, video, q } = setup();
    fireEvent.click(button(root, "Play"));
    const seek = q(".mp-seek");
    stubRect(q(".mp-track"), 100, 400);
    stubRect(seek, 100, 400);
    fireEvent.pointerDown(seek, { clientX: 200, pointerId: 1 });
    expect(video.currentTime).toBeCloseTo(0.25 * DURATION);
    expect(video.paused).toBe(true);
    fireEvent.pointerMove(seek, { clientX: 400, pointerId: 1 });
    expect(video.currentTime).toBeCloseTo(0.75 * DURATION);
    // Past the end clamps to it.
    fireEvent.pointerMove(seek, { clientX: 900, pointerId: 1 });
    expect(video.currentTime).toBe(DURATION);
    fireEvent.pointerUp(seek, { clientX: 900, pointerId: 1 });
    expect(video.paused).toBe(false);
  });

  it("the right-hand time toggles remaining / total", () => {
    const { q } = setup();
    const total = q(".mp-time-total");
    expect(total.textContent).toBe("-1:00");
    fireEvent.click(total);
    expect(total.textContent).toBe("1:00");
  });
});

describe("volume", () => {
  it("the capsule's slider sets the level; its ends are mute and full", () => {
    const { video, q } = setup();
    const slider = q<HTMLInputElement>(".mp-volume input[type=range]");
    expect(slider.getAttribute("aria-orientation")).toBe("vertical");
    fireEvent.change(slider, { target: { value: "0.4" } });
    expect(video.volume).toBeCloseTo(0.4);
    expect(video.muted).toBe(false);
    fireEvent.change(slider, { target: { value: "0" } });
    expect(video.volume).toBe(0);
    expect(video.muted).toBe(true);
    fireEvent.change(slider, { target: { value: "1" } });
    expect(video.volume).toBe(1);
    expect(video.muted).toBe(false);
  });

  it("unmuting a level of 0 comes back at half; M mutes", () => {
    const { root, video, key, q } = setup();
    fireEvent.change(q(".mp-volume input[type=range]"), {
      target: { value: "0" },
    });
    fireEvent.click(button(root, "Unmute"));
    expect(video.volume).toBe(0.5);
    expect(video.muted).toBe(false);
    key(root, "m");
    expect(video.muted).toBe(true);
  });

  it("↑ / ↓ step the volume by 10%", () => {
    const { root, video, key } = setup();
    act(() => {
      video.volume = 0.5;
    });
    key(root, "ArrowUp");
    expect(video.volume).toBeCloseTo(0.6);
    key(root, "ArrowDown");
    key(root, "ArrowDown");
    expect(video.volume).toBeCloseTo(0.4);
  });

  it("hovering the speaker opens the capsule", () => {
    const { root, q } = setup();
    const speaker = button(root, "Mute").parentElement!;
    fireEvent.pointerEnter(speaker);
    expect(q(".mp-volume").hasAttribute("data-open")).toBe(true);
    expect(root.hasAttribute("data-volume-open")).toBe(true);
  });
});

describe("speed dial", () => {
  function openSettings() {
    const s = setup();
    fireEvent.click(button(s.root, "Settings"));
    const dial = s.q(".mp-dial");
    const readout = () => s.q(".mp-speed").textContent;
    return { ...s, dial, readout };
  }

  it("keys step the speed and jump to the ends", () => {
    const { dial, readout, video } = openSettings();
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(readout()).toBe("1.05×");
    expect(video.playbackRate).toBe(1.05);
    fireEvent.keyDown(dial, { key: "End" });
    expect(readout()).toBe("3.00×");
    fireEvent.keyDown(dial, { key: "ArrowUp" });
    expect(readout()).toBe("3.00×");
    fireEvent.keyDown(dial, { key: "Home" });
    expect(readout()).toBe("0.25×");
  });

  it("a drag follows unsnapped and settles onto the step", () => {
    const { dial, readout } = openSettings();
    stubRect(dial, 0, 200);
    fireEvent.pointerDown(dial, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(dial, {
      clientX: 100 - 1.4 * DIAL_PX_PER_STEP,
      pointerId: 1,
    });
    expect(readout()).toBe("1.07×");
    fireEvent.pointerUp(dial, {
      clientX: 100 - 1.4 * DIAL_PX_PER_STEP,
      pointerId: 1,
    });
    expect(readout()).toBe("1.05×");
  });

  it("a click picks the speed under the pointer", () => {
    const { dial, readout } = openSettings();
    stubRect(dial, 0, 200);
    const x = 100 + 4 * DIAL_PX_PER_STEP;
    fireEvent.pointerDown(dial, { clientX: x, pointerId: 1 });
    fireEvent.pointerUp(dial, { clientX: x, pointerId: 1 });
    expect(readout()).toBe("1.20×");
  });

  it("chips pick a preset; the gear wears the speed; reset brings back 1×", () => {
    const { root, q, readout } = openSettings();
    const chip = Array.from(root.querySelectorAll(".mp-chip")).find(
      (c) => c.textContent === "2×",
    )!;
    fireEvent.click(chip);
    expect(readout()).toBe("2.00×");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(q(".mp-badge").textContent).toBe("2×");
    fireEvent.click(button(root, "Reset speed"));
    expect(readout()).toBe("1.00×");
    expect(root.querySelector(".mp-badge")).toBeNull();
  });

  it("< / > change the speed by 0.25, clamped", () => {
    const { root, video, key } = setup();
    key(root, ">", { shiftKey: true });
    expect(video.playbackRate).toBe(1.25);
    for (let i = 0; i < 10; i++) key(root, "<", { shiftKey: true });
    expect(video.playbackRate).toBe(0.25);
  });

  it("R and the Loop row toggle looping", () => {
    const { root, video, key } = openSettings();
    key(root, "r");
    expect(video.loop).toBe(true);
    const row = root.querySelector('[role="switch"]')!;
    expect(row.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(row);
    expect(video.loop).toBe(false);
  });
});

describe("idle", () => {
  it("the controls fade 2 s after the pointer rests while playing", () => {
    vi.useFakeTimers();
    const { root } = setup();
    fireEvent.click(button(root, "Play"));
    fireEvent.pointerMove(root);
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(root.hasAttribute("data-idle")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(root.hasAttribute("data-idle")).toBe(true);
    // Moving wakes them.
    fireEvent.pointerMove(root);
    expect(root.hasAttribute("data-idle")).toBe(false);
  });

  it("fade while paused too", () => {
    vi.useFakeTimers();
    const { root } = setup();
    fireEvent.pointerMove(root);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(root.hasAttribute("data-idle")).toBe(true);
  });

  it("leaving the player while paused fades at once", () => {
    const { root } = setup();
    fireEvent.pointerLeave(root);
    expect(root.hasAttribute("data-idle")).toBe(true);
  });

  it("never while the settings are open", () => {
    vi.useFakeTimers();
    const { root } = setup();
    fireEvent.click(button(root, "Play"));
    fireEvent.click(button(root, "Settings"));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(root.hasAttribute("data-idle")).toBe(false);
  });

  it("leaving the player while playing fades at once", () => {
    const { root } = setup();
    fireEvent.click(button(root, "Play"));
    fireEvent.pointerLeave(root);
    expect(root.hasAttribute("data-idle")).toBe(true);
  });

  it("audio never fades", () => {
    vi.useFakeTimers();
    setup({ kind: "audio" });
    const root = document.querySelector<HTMLElement>("[data-media-player]")!;
    fireEvent.click(button(root, "Play"));
    fireEvent.pointerLeave(root);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(root.hasAttribute("data-idle")).toBe(false);
  });
});

describe("picture in picture", () => {
  function withRefusingPip(error: unknown) {
    const requestWindow = vi.fn(() => Promise.reject(error));
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: { requestWindow },
    });
    const videoPip = vi.fn(() => Promise.resolve({}));
    Object.defineProperty(
      HTMLVideoElement.prototype,
      "requestPictureInPicture",
      {
        configurable: true,
        value: videoPip,
      },
    );
    return { requestWindow, videoPip };
  }

  it("a refused window falls back to the video's own picture in picture", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { requestWindow, videoPip } = withRefusingPip(
      new DOMException("only allowed from a top-level browsing context"),
    );
    const { root, key } = setup();
    key(root, "p");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(videoPip).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("an opened window takes the player and leaves Bring back on the page", async () => {
    const pipDoc = document.implementation.createHTMLDocument("pip");
    const listeners: Record<string, () => void> = {};
    const pipWin = {
      document: pipDoc,
      close: vi.fn(() => listeners.pagehide?.()),
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
    } as unknown as Window;
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: { requestWindow: vi.fn(() => Promise.resolve(pipWin)) },
    });
    const { root, key, getByText } = setup();
    key(root, "p");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pipDoc.body.contains(root)).toBe(true);
    expect(pipDoc.documentElement.hasAttribute("data-pip")).toBe(true);
    act(() => {
      fireEvent.click(getByText("Bring back"));
    });
    expect(document.body.contains(root)).toBe(true);
  });
});

describe("review fixes", () => {
  function pointer(type: string, init: PointerEventInit = {}) {
    return new PointerEvent(type, { bubbles: true, pointerId: 1, ...init });
  }

  it("keys outside every player: Space only, never arrows or letters", () => {
    const { getByTestId, video, key } = setup();
    act(() => {
      video.currentTime = 30;
    });
    const outside = getByTestId("outside");
    key(outside, "ArrowRight");
    key(outside, "m");
    key(outside, "3");
    expect(video.currentTime).toBe(30);
    expect(video.muted).toBe(false);
    key(outside, " ");
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("the focused seek bar takes its own keys (↑ seeks, not the volume)", () => {
    const { video, q, key } = setup();
    act(() => {
      video.currentTime = 30;
      video.volume = 0.5;
    });
    const seek = q(".mp-seek");
    seek.focus();
    key(seek, "ArrowUp");
    expect(video.currentTime).toBe(35);
    expect(video.volume).toBe(0.5);
    key(seek, "PageUp");
    expect(video.currentTime).toBe(41);
    key(seek, "Home");
    expect(video.currentTime).toBe(0);
    key(seek, "End");
    expect(video.currentTime).toBe(DURATION);
  });

  it("a11y: no aria-expanded on the mute button; the label is announced once", () => {
    const { root, video } = setup();
    expect(button(root, "Mute").hasAttribute("aria-expanded")).toBe(false);
    expect(video.hasAttribute("aria-label")).toBe(false);
    expect(root.getAttribute("aria-label")).toBe("Clip");
  });

  it("only the primary button drags; a lost capture ends the drag", () => {
    const { root, video, q } = setup();
    fireEvent.click(button(root, "Play"));
    const seek = q(".mp-seek");
    stubRect(q(".mp-track"), 0, 400);
    act(() => {
      seek.dispatchEvent(pointer("pointerdown", { button: 2, clientX: 100 }));
    });
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(0);
    act(() => {
      seek.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 100 }));
    });
    expect(video.paused).toBe(true);
    // Scrubbing is not paused: no big play button over the frame.
    expect(root.hasAttribute("data-paused")).toBe(false);
    act(() => {
      seek.dispatchEvent(pointer("lostpointercapture"));
    });
    expect(video.paused).toBe(false);
    expect(seek.hasAttribute("data-dragging")).toBe(false);
  });

  it("the capsule follows keyboard focus: Tab into it, closed once focus leaves", () => {
    vi.useFakeTimers();
    const { root, q, getByTestId } = setup();
    const mute = button(root, "Mute");
    act(() => {
      mute.focus();
    });
    const capsule = q(".mp-volume");
    expect(capsule.hasAttribute("data-open")).toBe(true);
    const slider = capsule.querySelector("input")!;
    fireEvent.keyDown(mute, { key: "Tab" });
    expect(document.activeElement).toBe(slider);
    // Tab out of the capsule goes on to the seek bar, the next control.
    fireEvent.keyDown(slider, { key: "Tab" });
    expect(document.activeElement).toBe(q(".mp-seek"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(capsule.hasAttribute("data-open")).toBe(false);
    // And from the speaker straight out of the player, too.
    act(() => {
      mute.focus();
    });
    expect(capsule.hasAttribute("data-open")).toBe(true);
    act(() => {
      getByTestId("outside").focus();
      vi.advanceTimersByTime(500);
    });
    expect(capsule.hasAttribute("data-open")).toBe(false);
  });

  it("the capsule's keys step 5%", () => {
    const { video, q } = setup();
    act(() => {
      video.volume = 0.5;
    });
    const slider = q<HTMLInputElement>(".mp-volume input");
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.55);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(video.volume).toBeCloseTo(0.45);
  });

  it("preload: metadata until autoplay or a first play", () => {
    const { root, video } = setup();
    expect(video.getAttribute("preload")).toBe("metadata");
    fireEvent.click(button(root, "Play"));
    expect(video.getAttribute("preload")).toBe("auto");
  });

  it("two quick P presses ask for one window", async () => {
    let resolve: (w: Window) => void = () => undefined;
    const requestWindow = vi.fn(
      () => new Promise<Window>((r) => (resolve = r)),
    );
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: { requestWindow },
    });
    const { root, key } = setup();
    key(root, "p");
    key(root, "p");
    expect(requestWindow).toHaveBeenCalledTimes(1);
    const pipDoc = document.implementation.createHTMLDocument("pip");
    await act(async () => {
      resolve({
        document: pipDoc,
        close: () => undefined,
        addEventListener: () => undefined,
      } as unknown as Window);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("in its own window: full screen asks that window's document; panels close on the way back", async () => {
    const pipDoc = document.implementation.createHTMLDocument("pip");
    const listeners: Record<string, () => void> = {};
    const pipWin = {
      document: pipDoc,
      close: vi.fn(() => listeners.pagehide?.()),
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
    } as unknown as Window;
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: { requestWindow: vi.fn(() => Promise.resolve(pipWin)) },
    });
    const { root, key, getByText } = setup();
    key(root, "p");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pipDoc.body.contains(root)).toBe(true);
    // The window's own full screen, not the page's.
    Object.defineProperty(pipDoc, "fullscreenElement", {
      configurable: true,
      get: () => root,
    });
    act(() => {
      pipDoc.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(button(root, "Exit full screen")).toBeTruthy();
    // Settings opened in the window close when the player comes back.
    act(() => {
      button(root, "Settings").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(root.hasAttribute("data-settings-open")).toBe(true);
    act(() => {
      fireEvent.click(getByText("Bring back"));
    });
    expect(document.body.contains(root)).toBe(true);
    expect(root.hasAttribute("data-settings-open")).toBe(false);
  });
});

describe("a live playhead (WebKit)", () => {
  it("renders without looping when currentTime advances on every read", () => {
    // WKWebView's currentTime is a live clock, not a value held between
    // `timeupdate`s: reading it during render must not count as a change.
    let t = 0;
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => (t += 0.001),
      set: () => undefined,
    });
    const { video, q, rerender } = setup();
    rerender(
      <WithShortcuts>
        <MediaPlayer kind="video" src="clip.mp4" label="Clip" />
      </WithShortcuts>,
    );
    act(() => {
      video.dispatchEvent(new Event("timeupdate"));
    });
    expect(q(".mp-time").textContent).toBe("0:00");
  });
});
