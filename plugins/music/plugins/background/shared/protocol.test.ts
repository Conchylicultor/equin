import { describe, expect, test } from "bun:test";
import {
  INITIAL_MUSIC_STATE,
  busyElsewhere,
  nowPlaying,
  startedPlaying,
  step,
  type MusicEvent,
  type MusicState,
} from "./protocol";

const run = (events: MusicEvent[], from: MusicState = INITIAL_MUSIC_STATE) =>
  events.reduce(step, from);

const show = (sourceId: string): MusicEvent => ({
  kind: "shown",
  sourceId,
  delta: 1,
  acrossApps: false,
});
const hide = (sourceId: string, acrossApps = false): MusicEvent => ({
  kind: "shown",
  sourceId,
  delta: -1,
  acrossApps,
});

describe("leaving the app", () => {
  test("pauses its music when music is not kept across apps", () => {
    const s = run([
      show("isle"),
      { kind: "play", sourceId: "isle" },
      hide("isle"),
    ]);
    expect(s.current).toEqual({ sourceId: "isle", playing: false });
  });

  test("keeps it playing when music is kept across apps", () => {
    const s = run([
      show("isle"),
      { kind: "play", sourceId: "isle" },
      hide("isle", true),
    ]);
    expect(s.current).toEqual({ sourceId: "isle", playing: true });
  });

  test("does nothing while another view of it is still on screen (desktop windows)", () => {
    const s = run([
      show("isle"),
      show("isle"),
      { kind: "play", sourceId: "isle" },
      hide("isle"),
    ]);
    expect(s.current?.playing).toBe(true);
  });

  test("leaving another app does not touch it", () => {
    const s = run([
      show("isle"),
      show("other"),
      { kind: "play", sourceId: "isle" },
      hide("other"),
    ]);
    expect(s.current?.playing).toBe(true);
  });

  test("a view hidden more often than shown is a bug", () => {
    expect(() => run([hide("isle")])).toThrow(/hidden more often/);
  });
});

describe("foreground music", () => {
  test("pauses background music nobody sees", () => {
    const s = run([
      show("isle"),
      { kind: "play", sourceId: "isle" },
      hide("isle", true),
      { kind: "foreground" },
    ]);
    expect(s.current?.playing).toBe(false);
  });

  test("mixes with music whose view is on screen", () => {
    const s = run([
      show("isle"),
      { kind: "play", sourceId: "isle" },
      { kind: "foreground" },
    ]);
    expect(s.current?.playing).toBe(true);
  });
});

describe("other pages", () => {
  test("a claim from another page pauses this one", () => {
    const s = run([
      show("isle"),
      { kind: "play", sourceId: "isle" },
      { kind: "remote-claim" },
    ]);
    expect(s.current?.playing).toBe(false);
  });

  test("the button shows what plays, here first", () => {
    const remote = {
      kind: "remote-state",
      pageId: "p2",
      now: { sourceId: "isle", title: "Lo-fi", playing: true },
    } as const;
    expect(nowPlaying(run([remote]))).toEqual({
      where: "remote",
      pageId: "p2",
      sourceId: "isle",
      title: "Lo-fi",
      playing: true,
    });
    const here = run([remote, { kind: "play", sourceId: "isle" }]);
    expect(nowPlaying(here)).toEqual({
      where: "here",
      sourceId: "isle",
      playing: true,
    });
  });

  test("a page that goes away is forgotten", () => {
    const s = run([
      {
        kind: "remote-state",
        pageId: "p2",
        now: { sourceId: "isle", title: "Lo-fi", playing: true },
      },
      { kind: "remote-gone", pageId: "p3" },
    ]);
    expect(s.remote?.pageId).toBe("p2");
    expect(run([{ kind: "remote-gone", pageId: "p2" }], s).remote).toBeNull();
  });

  test("auto-play gives way to music playing elsewhere", () => {
    const s = run([
      {
        kind: "remote-state",
        pageId: "p2",
        now: { sourceId: "isle", title: "Lo-fi", playing: true },
      },
    ]);
    expect(busyElsewhere(s, "isle")).toBe(true);
    expect(busyElsewhere(INITIAL_MUSIC_STATE, "isle")).toBe(false);
  });
});

test("startedPlaying: a new play or a resume is a claim, a pause is not", () => {
  const a = run([{ kind: "play", sourceId: "isle" }]);
  expect(startedPlaying(INITIAL_MUSIC_STATE, a)).toBe(true);
  const b = step(a, { kind: "pause" });
  expect(startedPlaying(a, b)).toBe(false);
  expect(startedPlaying(b, step(b, { kind: "resume" }))).toBe(true);
});

describe("music adopted from an app's view", () => {
  test("becomes what plays, replacing the current music, when kept across apps", () => {
    const prev = run([{ kind: "play", sourceId: "isle" }]);
    const s = step(prev, {
      kind: "adopt",
      sourceId: "sonata",
      acrossApps: true,
    });
    expect(s.current).toEqual({ sourceId: "sonata", playing: true });
    expect(startedPlaying(prev, s)).toBe(true);
  });

  test("ends with its view when not kept across apps", () => {
    const prev = run([{ kind: "play", sourceId: "isle" }]);
    const s = step(prev, {
      kind: "adopt",
      sourceId: "sonata",
      acrossApps: false,
    });
    expect(s).toBe(prev);
  });

  test("pauses when another browser tab starts music", () => {
    const s = run([
      { kind: "adopt", sourceId: "sonata", acrossApps: true },
      { kind: "remote-claim" },
    ]);
    expect(s.current).toEqual({ sourceId: "sonata", playing: false });
  });
});
