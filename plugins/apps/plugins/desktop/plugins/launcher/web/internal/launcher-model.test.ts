import { describe, expect, test } from "bun:test";
import {
  LAUNCHER_COLUMNS,
  clampSelection,
  listLauncher,
  moveSelection,
  windowsByApp,
} from "./launcher-model";

const apps = [{ name: "Agents" }, { name: "Mail" }, { name: "Pages" }];
const commands = [{ label: "Show overview" }, { label: "Tile all windows" }];

describe("listLauncher", () => {
  test("an empty query is the grid of every app, no commands", () => {
    const listing = listLauncher("  ", apps, commands);
    expect(listing.layout).toBe("grid");
    expect(listing.commands).toEqual([]);
    expect(listing.items.map((i) => i.kind)).toEqual(["app", "app", "app"]);
  });

  test("a query lists matching apps then matching commands, case-insensitively", () => {
    const listing = listLauncher("A", apps, commands);
    expect(listing.layout).toBe("list");
    expect(listing.apps.map((a) => a.name)).toEqual([
      "Agents",
      "Mail",
      "Pages",
    ]);
    expect(listing.commands.map((c) => c.label)).toEqual(["Tile all windows"]);
    expect(listing.items).toHaveLength(4);
    expect(listing.items[3]).toEqual({
      kind: "command",
      command: commands[1]!,
    });
  });

  test("no match is an empty listing", () => {
    expect(listLauncher("zzz", apps, commands).items).toEqual([]);
  });
});

describe("moveSelection", () => {
  test("the grid steps a column vertically and one horizontally", () => {
    expect(moveSelection(1, "ArrowDown", "grid", 20)).toBe(
      1 + LAUNCHER_COLUMNS,
    );
    expect(moveSelection(8, "ArrowUp", "grid", 20)).toBe(8 - LAUNCHER_COLUMNS);
    expect(moveSelection(3, "ArrowRight", "grid", 20)).toBe(4);
    expect(moveSelection(3, "ArrowLeft", "grid", 20)).toBe(2);
  });

  test("the list steps by one vertically and ignores left / right", () => {
    expect(moveSelection(2, "ArrowDown", "list", 5)).toBe(3);
    expect(moveSelection(2, "ArrowUp", "list", 5)).toBe(1);
    expect(moveSelection(2, "ArrowRight", "list", 5)).toBe(2);
    expect(moveSelection(2, "ArrowLeft", "list", 5)).toBe(2);
  });

  test("the ends clamp and an empty listing stays at 0", () => {
    expect(moveSelection(0, "ArrowUp", "list", 5)).toBe(0);
    expect(moveSelection(4, "ArrowDown", "list", 5)).toBe(4);
    expect(moveSelection(3, "ArrowDown", "grid", 4)).toBe(3);
    expect(moveSelection(0, "ArrowDown", "list", 0)).toBe(0);
    expect(clampSelection(9, 0)).toBe(0);
  });
});

describe("windowsByApp", () => {
  const win = (
    id: string,
    desktopId: string,
    activeTabId: string,
    z: number,
  ) => ({
    id,
    desktopId,
    activeTabId,
    geo: { z },
  });
  const appOfTab = new Map([
    ["t1", "mail"],
    ["t2", "mail"],
    ["t3", "pages"],
  ]);

  test("files windows under their active tab's app, front-most first", () => {
    const byApp = windowsByApp(
      [
        win("a", "d1", "t1", 1),
        win("b", "d1", "t2", 3),
        win("c", "d1", "t3", 2),
      ],
      "d1",
      appOfTab,
    );
    expect(byApp.get("mail")?.map((w) => w.id)).toEqual(["b", "a"]);
    expect(byApp.get("pages")?.map((w) => w.id)).toEqual(["c"]);
  });

  test("skips other desktops and windows whose tab is unknown", () => {
    const byApp = windowsByApp(
      [win("a", "d2", "t1", 1), win("b", "d1", "gone", 2)],
      "d1",
      appOfTab,
    );
    expect(byApp.size).toBe(0);
  });
});
