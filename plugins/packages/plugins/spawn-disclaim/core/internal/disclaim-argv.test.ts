import { describe, expect, test } from "bun:test";
import {
  NO_SPAWN_DISCLAIM_ENV,
  disclaimArgv,
  spawnDisclaimWanted,
} from "./disclaim-argv";

describe("spawnDisclaimWanted", () => {
  test("on macOS by default", () => {
    expect(spawnDisclaimWanted({}, "darwin")).toBe(true);
  });
  test("never off macOS", () => {
    expect(spawnDisclaimWanted({}, "linux")).toBe(false);
  });
  test("off with the escape hatch", () => {
    expect(
      spawnDisclaimWanted({ [NO_SPAWN_DISCLAIM_ENV]: "1" }, "darwin"),
    ).toBe(false);
  });
  test("only `1` turns it off", () => {
    expect(
      spawnDisclaimWanted({ [NO_SPAWN_DISCLAIM_ENV]: "0" }, "darwin"),
    ).toBe(true);
  });
});

describe("disclaimArgv", () => {
  const argv: [string, ...string[]] = [
    "/usr/local/bin/claude",
    "--output-format",
    "stream-json",
  ];

  test("prefixes the helper when wanted", () => {
    expect(disclaimArgv("/cache/disclaim-exec", argv, true)).toEqual([
      "/cache/disclaim-exec",
      ...argv,
    ]);
  });
  test("unchanged without a helper", () => {
    expect(disclaimArgv(null, argv, true)).toEqual(argv);
  });
  test("unchanged when not wanted", () => {
    expect(disclaimArgv("/cache/disclaim-exec", argv, false)).toEqual(argv);
  });
  test("returns a copy, never the caller's array", () => {
    expect(disclaimArgv(null, argv, true)).not.toBe(argv);
  });
  test("an empty argv has no spelling", () => {
    // @ts-expect-error — argv names the program at least.
    expect(disclaimArgv(null, [], true)).toEqual([]);
  });
});
