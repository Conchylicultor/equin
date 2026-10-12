import { describe, expect, it } from "bun:test";
import type { DriverState } from "@plugins/apps/plugins/sonata/plugins/session/web";
import type {
  YouTubePlayerController,
  YouTubePlayerState,
} from "@plugins/integrations/plugins/youtube/web";
import { createVideoDriver } from "./driver";

/** A controller the test sets by hand. */
class FakeController {
  snapshot: YouTubePlayerState = { kind: "loading" };
  isPlaying = false;
  isAdvancing = false;
  time = 0;
  calls: string[] = [];
  private listeners = new Set<() => void>();

  play() {
    this.calls.push("play");
  }
  pause() {
    this.calls.push("pause");
  }
  seek(s: number) {
    this.calls.push(`seek ${s}`);
  }
  getCurrentTime = () => this.time;
  getPlaybackRate = () => 1;
  setPlaybackRate = (r: number) => Promise.resolve(r);
  getSnapshot = () => this.snapshot;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  set(
    next: Partial<
      Pick<FakeController, "snapshot" | "isPlaying" | "isAdvancing">
    >,
  ) {
    Object.assign(this, next);
    for (const l of this.listeners) l();
  }
  /** The controller as the driver sees it (only the members it calls exist). */
  get asController(): YouTubePlayerController {
    return this as unknown as YouTubePlayerController;
  }
}

const READY: YouTubePlayerState = {
  kind: "ready",
  videoId: "QDYfEBY9NM4",
  playing: false,
  started: false,
  duration: 243,
};

describe("createVideoDriver", () => {
  it("maps the player's states, pushing only changes", () => {
    const c = new FakeController();
    c.snapshot = READY;
    const driver = createVideoDriver(c.asController, () => 0);
    const seen: DriverState["kind"][] = [];
    driver.subscribe((s) => seen.push(s.kind));
    c.set({ isPlaying: true }); // buffering on the way to playing
    c.set({ isAdvancing: true });
    c.set({ isAdvancing: true }); // no change
    c.set({ isPlaying: false, isAdvancing: false });
    c.set({ snapshot: { kind: "error", videoId: READY.videoId, code: 150 } });
    expect(seen).toEqual([
      "paused",
      "stalled",
      "advancing",
      "paused",
      "failed",
    ]);
  });

  it("answers a position only while advancing, shifted by the sync offset both ways", () => {
    const c = new FakeController();
    c.snapshot = READY;
    const offset = { sec: 0.1 };
    const driver = createVideoDriver(c.asController, () => offset.sec);
    c.time = 30;
    expect(driver.position()).toBeNull();
    c.isAdvancing = true;
    c.isPlaying = true;
    expect(driver.position()).toBeCloseTo(29.9, 2);
    driver.seek(12);
    expect(c.calls.at(-1)).toBe("seek 12.1");
    // Seeking to the medium's start never asks for a negative time.
    offset.sec = -0.2;
    driver.seek(0);
    expect(c.calls.at(-1)).toBe("seek 0");
  });

  it("drops transport calls once the player is gone", () => {
    const c = new FakeController();
    const driver = createVideoDriver(c.asController, () => 0);
    driver.play();
    driver.pause();
    driver.seek(3);
    expect(c.calls).toEqual([]);
  });
});
