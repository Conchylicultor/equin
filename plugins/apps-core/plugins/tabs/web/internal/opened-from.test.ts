import { describe, expect, test } from "bun:test";
import { openedFromAfterSwap } from "./opened-from";

const launchers = new Set(["isle", "hub"]);
const isLauncher = (id: string) => launchers.has(id);

describe("openedFromAfterSwap", () => {
  test("leaving a launcher app pushes it", () => {
    expect(
      openedFromAfterSwap(
        { appId: "isle", openedFrom: [] },
        "mail",
        isLauncher,
      ),
    ).toEqual(["isle"]);
  });

  test("a swap between ordinary apps keeps the stack", () => {
    expect(
      openedFromAfterSwap(
        { appId: "mail", openedFrom: ["isle"] },
        "pages",
        isLauncher,
      ),
    ).toEqual(["isle"]);
  });

  test("landing back on a launcher pops to below it", () => {
    expect(
      openedFromAfterSwap(
        { appId: "mail", openedFrom: ["isle"] },
        "isle",
        isLauncher,
      ),
    ).toEqual([]);
  });

  test("launchers nest: each one is a step back", () => {
    const fromHub = openedFromAfterSwap(
      { appId: "hub", openedFrom: ["isle"] },
      "mail",
      isLauncher,
    );
    expect(fromHub).toEqual(["isle", "hub"]);
    const backAtHub = openedFromAfterSwap(
      { appId: "mail", openedFrom: fromHub },
      "hub",
      isLauncher,
    );
    expect(backAtHub).toEqual(["isle"]);
    expect(
      openedFromAfterSwap(
        { appId: "hub", openedFrom: backAtHub },
        "isle",
        isLauncher,
      ),
    ).toEqual([]);
  });

  test("jumping to a deeper launcher drops what was above it", () => {
    expect(
      openedFromAfterSwap(
        { appId: "mail", openedFrom: ["isle", "hub"] },
        "isle",
        isLauncher,
      ),
    ).toEqual([]);
  });
});
