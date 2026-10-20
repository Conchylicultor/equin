import { describe, expect, test } from "bun:test";
import { alreadyShort, parseShortTitle, parseTitles } from "./title-parse";

describe("alreadyShort", () => {
  test("a title of three words or fewer is its own short title", () => {
    expect(alreadyShort("Fix login")).toBe("Fix login");
    expect(alreadyShort("  Fix   the  login ")).toBe("Fix the login");
  });

  test("a longer title needs shortening", () => {
    expect(alreadyShort("Fix the login page")).toBeUndefined();
  });

  test("a few words that are too many characters need shortening", () => {
    expect(
      alreadyShort("Fix plugins/tasks/plugins/task-title/server"),
    ).toBeUndefined();
  });

  test("an empty title has no short title", () => {
    expect(alreadyShort("   ")).toBeUndefined();
  });
});

describe("parseShortTitle", () => {
  test("accepts a plain answer", () => {
    expect(parseShortTitle("Login redirect fix")).toEqual({
      ok: true,
      shortTitle: "Login redirect fix",
    });
  });

  test("strips wrapping quotes, a trailing period and whitespace", () => {
    expect(parseShortTitle('  "Login fix."  ')).toEqual({
      ok: true,
      shortTitle: "Login fix",
    });
    expect(parseShortTitle("“Sidebar  width”")).toEqual({
      ok: true,
      shortTitle: "Sidebar width",
    });
    expect(parseShortTitle("`Queue pins`")).toEqual({
      ok: true,
      shortTitle: "Queue pins",
    });
  });

  test("rejects more than three words", () => {
    expect(parseShortTitle("Fix the login page").ok).toBe(false);
  });

  test("rejects an empty answer", () => {
    expect(parseShortTitle("").ok).toBe(false);
    expect(parseShortTitle(' "" ').ok).toBe(false);
  });

  test("rejects an over-long token", () => {
    expect(parseShortTitle("a".repeat(29)).ok).toBe(false);
    expect(parseShortTitle("Hardcode contribution order").ok).toBe(true);
  });
});

describe("parseTitles", () => {
  test("reads both labelled lines", () => {
    expect(
      parseTitles("TITLE: Fix the login redirect loop\nSHORT: Login redirect"),
    ).toEqual({
      title: "Fix the login redirect loop",
      short: { ok: true, shortTitle: "Login redirect" },
    });
  });

  test("tolerates case, bold labels, quotes and surrounding chatter", () => {
    expect(
      parseTitles(
        'Here you go:\n**Title:** "Add dark mode toggle."\n**short**: `Dark mode`\n',
      ),
    ).toEqual({
      title: "Add dark mode toggle",
      short: { ok: true, shortTitle: "Dark mode" },
    });
  });

  test("keeps the usable half when the other is unusable", () => {
    expect(parseTitles("TITLE: Fix login\nSHORT: Fix the login page")).toEqual({
      title: "Fix login",
      short: { ok: false, reason: "4 words: Fix the login page" },
    });
    expect(parseTitles("SHORT: Login fix")).toEqual({
      title: undefined,
      short: { ok: true, shortTitle: "Login fix" },
    });
  });

  test("an unlabelled answer carries neither", () => {
    expect(parseTitles("Fix login")).toEqual({
      title: undefined,
      short: { ok: false, reason: "no SHORT line" },
    });
  });

  test("caps the title at 80 characters", () => {
    const { title } = parseTitles(`TITLE: ${"a".repeat(100)}\nSHORT: x`);
    expect(title).toHaveLength(78);
    expect(title?.endsWith("…")).toBe(true);
  });
});
