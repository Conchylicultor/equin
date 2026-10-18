import { describe, expect, it } from "bun:test";
import {
  entryClick,
  shelfEntries,
  windowClick,
  type ShelfWindow,
} from "./shelf-model";

const win = (
  id: string,
  appId: string,
  opts: Partial<ShelfWindow> = {},
): ShelfWindow => ({ id, appId, minimized: false, z: 1, ...opts });

const installed = new Set(["agent-manager", "mail", "pages", "home", "music"]);

describe("shelfEntries", () => {
  it("lists the pinned apps first, in config order, with or without windows", () => {
    const entries = shelfEntries(["mail", "agent-manager"], [], installed);
    expect(entries).toEqual([
      { appId: "mail", section: "pinned", windows: [] },
      { appId: "agent-manager", section: "pinned", windows: [] },
    ]);
  });

  it("follows the pinned apps with the running unpinned ones, in first-open order", () => {
    const windows = [
      win("w1", "music"),
      win("w2", "mail"),
      win("w3", "home"),
      win("w4", "music"),
    ];
    const entries = shelfEntries(["mail"], windows, installed);
    expect(entries.map((e) => [e.appId, e.section])).toEqual([
      ["mail", "pinned"],
      ["music", "running"],
      ["home", "running"],
    ]);
    expect(entries[1]!.windows.map((w) => w.id)).toEqual(["w1", "w4"]);
  });

  it("files a window under its active tab's app, keeping first-open order inside a group", () => {
    const windows = [win("w2", "pages"), win("w1", "pages")];
    const [entry] = shelfEntries(["pages"], windows, installed);
    expect(entry!.windows.map((w) => w.id)).toEqual(["w2", "w1"]);
  });

  it("skips a pinned id or a window app that is not installed, and a duplicate pin", () => {
    const entries = shelfEntries(
      ["gone", "mail", "mail"],
      [win("w1", "also-gone")],
      installed,
    );
    expect(entries.map((e) => e.appId)).toEqual(["mail"]);
  });
});

describe("windowClick", () => {
  it("restores a minimised window", () => {
    expect(windowClick(win("w", "mail", { minimized: true }), "w")).toEqual({
      kind: "restore",
      windowId: "w",
    });
  });
  it("minimises the focused window", () => {
    expect(windowClick(win("w", "mail"), "w")).toEqual({
      kind: "minimize",
      windowId: "w",
    });
  });
  it("focuses a window in the background", () => {
    expect(windowClick(win("w", "mail"), "other")).toEqual({
      kind: "focus",
      windowId: "w",
    });
  });
});

describe("entryClick", () => {
  it("opens the app when it has no window", () => {
    expect(entryClick([], null)).toEqual({ kind: "open" });
  });

  it("acts on the one window like a window click", () => {
    expect(entryClick([win("w", "mail")], "w")).toEqual({
      kind: "minimize",
      windowId: "w",
    });
  });

  it("brings the front-most visible window forward first", () => {
    const windows = [
      win("a", "mail", { z: 1 }),
      win("b", "mail", { z: 5 }),
      win("c", "mail", { z: 9, minimized: true }),
    ];
    expect(entryClick(windows, "elsewhere")).toEqual({
      kind: "focus",
      windowId: "b",
    });
  });

  it("restores the front-most window when every one is minimised", () => {
    const windows = [
      win("a", "mail", { z: 3, minimized: true }),
      win("b", "mail", { z: 2, minimized: true }),
    ];
    expect(entryClick(windows, null)).toEqual({
      kind: "restore",
      windowId: "a",
    });
  });

  it("cycles to the next window, wrapping, once one of them is focused", () => {
    const windows = [
      win("a", "mail"),
      win("b", "mail", { minimized: true }),
      win("c", "mail"),
    ];
    expect(entryClick(windows, "a")).toEqual({
      kind: "restore",
      windowId: "b",
    });
    expect(entryClick(windows, "c")).toEqual({ kind: "focus", windowId: "a" });
  });
});
