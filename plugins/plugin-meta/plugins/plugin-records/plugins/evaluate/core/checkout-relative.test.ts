import { describe, expect, test } from "bun:test";
import { checkoutRelative } from "./evaluate";

describe("checkoutRelative", () => {
  const real = "/srv/repo/.claude/worktrees/wt-1";
  const link = "/srv/link/wt-1";
  const { storeText, readText } = checkoutRelative([real, link]);

  test("a record names no checkout once stored, and reads back as this one", () => {
    const text = JSON.stringify({
      paths: [`${real}/plugins/x/data`, `${link}/plugins/y`, real],
    });
    const stored = storeText(text);
    expect(stored).not.toContain(real);
    expect(stored).not.toContain(link);
    expect(JSON.parse(readText(stored))).toEqual({
      paths: [`${real}/plugins/x/data`, `${real}/plugins/y`, real],
    });
  });

  test("another checkout reads the same stored text as its own", () => {
    const stored = storeText(JSON.stringify({ p: `${real}/a` }));
    const other = checkoutRelative(["/srv/other"]);
    expect(JSON.parse(other.readText(stored))).toEqual({
      p: "/srv/other/a",
    });
  });

  test("a path that only starts like the root is left alone", () => {
    const text = JSON.stringify({
      p: `${real}0/a`,
      q: `x${real}y`,
      sibling: `${real}.json`,
      tail: `/mnt${real}/a`,
    });
    expect(storeText(text)).toBe(text);
  });

  test("the root inside a longer string is replaced too", () => {
    const text = JSON.stringify({
      cmd: `cd ${real} && ls`,
      list: `${real}:${link}/b`,
    });
    const stored = storeText(text);
    expect(stored).not.toContain(real);
    expect(JSON.parse(readText(stored))).toEqual({
      cmd: `cd ${real} && ls`,
      list: `${real}:${real}/b`,
    });
  });

  test("a root holding replacement patterns reads back verbatim", () => {
    const odd = checkoutRelative(["/srv/a$&b$$c"]);
    const stored = odd.storeText(JSON.stringify({ p: "/srv/a$&b$$c/x" }));
    expect(JSON.parse(odd.readText(stored))).toEqual({ p: "/srv/a$&b$$c/x" });
  });
});
