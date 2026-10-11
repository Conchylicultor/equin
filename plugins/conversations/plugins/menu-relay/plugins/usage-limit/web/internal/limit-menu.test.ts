import { describe, expect, test } from "bun:test";
import type { TerminalMenu } from "@plugins/conversations/plugins/terminal-menu/core";
import {
  formatCountdown,
  isUsageLimitMenu,
  limitMenuOptions,
  parseResetTime,
} from "./limit-menu";

const MENU: TerminalMenu = {
  title: "What do you want to do?",
  body: "",
  options: [
    { n: 1, label: "Stop and wait for limit to reset", description: null },
    {
      n: 2,
      label: "Wait here, then continue automatically at Oct 13 at 6am",
      description: null,
    },
    { n: 3, label: "Switch to usage credits", description: null },
  ],
  highlighted: 1,
  footer: "Enter to confirm · Esc to cancel",
};

describe("the usage-limit menu", () => {
  test("is recognised by its options", () => {
    expect(isUsageLimitMenu(MENU)).toBe(true);
    expect(
      isUsageLimitMenu({
        ...MENU,
        options: [{ n: 1, label: "Yes", description: null }],
      }),
    ).toBe(false);
  });

  test("names each option, keeping any it does not know", () => {
    const extra = { n: 4, label: "Upgrade your plan", description: null };
    const named = limitMenuOptions({
      ...MENU,
      options: [...MENU.options, extra],
    });
    expect(named.stop?.n).toBe(1);
    expect(named.wait?.n).toBe(2);
    expect(named.credits?.n).toBe(3);
    expect(named.other).toEqual([extra]);
  });
});

describe("parseResetTime", () => {
  const now = new Date(2026, 9, 9, 13, 0); // Oct 9 2026, 13:00 local

  test("a dated reset", () => {
    expect(parseResetTime(MENU.options[1]!.label, now)).toEqual(
      new Date(2026, 9, 13, 6, 0),
    );
  });

  test("minutes and pm", () => {
    expect(
      parseResetTime("continue automatically at Oct 13 at 6:30pm", now),
    ).toEqual(new Date(2026, 9, 13, 18, 30));
  });

  test("12am is midnight, 12pm is noon", () => {
    expect(parseResetTime("at Oct 13 at 12am", now)).toEqual(
      new Date(2026, 9, 13, 0, 0),
    );
    expect(parseResetTime("at Oct 13 at 12pm", now)).toEqual(
      new Date(2026, 9, 13, 12, 0),
    );
  });

  test("a date early next year rolls over", () => {
    expect(
      parseResetTime("at Jan 2 at 6am", new Date(2026, 11, 30, 9, 0)),
    ).toEqual(new Date(2027, 0, 2, 6, 0));
  });

  test("a time alone is its next occurrence", () => {
    expect(parseResetTime("continue automatically at 6pm", now)).toEqual(
      new Date(2026, 9, 9, 18, 0),
    );
    expect(parseResetTime("continue automatically at 6am", now)).toEqual(
      new Date(2026, 9, 10, 6, 0),
    );
  });

  test("no time is null", () => {
    expect(
      parseResetTime("Wait here, then continue automatically", now),
    ).toBeNull();
    expect(parseResetTime("at Foo 13 at 6am", now)).toBeNull();
  });
});

test("formatCountdown", () => {
  expect(formatCountdown(30_000)).toBe("less than a minute");
  expect(formatCountdown(12 * 60_000)).toBe("12m");
  expect(formatCountdown((4 * 60 + 12) * 60_000)).toBe("4h 12m");
  expect(formatCountdown((3 * 1440 + 4 * 60 + 5) * 60_000)).toBe("3d 4h");
});
