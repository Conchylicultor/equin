import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { appPathParent, joinAppPath, type AppPath } from "./user-path";

describe("joinAppPath", () => {
  // node:path's POSIX join is the reference.
  const cases: [string, ...string[]][] = [
    ["/a", "b"],
    ["/a/", "b/"],
    ["/a", "/b"],

    ["/a//b", "./c"],
    ["a", "b"],

    ["/", "x"],
    ["/a", ""],
    ["/a", ".", ""],

    ["./a", "./"],
    ["/a", "b.lock"],
    ["/x/data", "kind", "name", "file.json"],
  ];
  for (const [dir, ...segments] of cases)
    it(`${JSON.stringify([dir, ...segments])}`, () => {
      expect<string>(joinAppPath(dir as AppPath, ...segments)).toBe(
        join(dir, ...segments),
      );
    });
});

describe("joinAppPath refuses a climb", () => {
  for (const segment of ["..", "../x", "a/../../b", "x/.."])
    it(JSON.stringify(segment), () => {
      expect(() => joinAppPath("/app" as AppPath, segment)).toThrow(
        /climbs out/,
      );
    });
  it("allows dots that are no segment", () => {
    expect<string>(joinAppPath("/app" as AppPath, "..x", "a..b", ".")).toBe(
      "/app/..x/a..b",
    );
  });
});

describe("appPathParent", () => {
  for (const path of ["/a/b", "/a/b/", "/a", "/", "a/b", "a", "/a//b"])
    it(JSON.stringify(path), () => {
      expect<string>(appPathParent(path as AppPath)).toBe(dirname(path));
    });
});
