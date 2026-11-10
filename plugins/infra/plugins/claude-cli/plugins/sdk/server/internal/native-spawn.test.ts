import { describe, expect, test } from "bun:test";
import { nativeSpawn } from "./native-spawn";

const signal = new AbortController().signal;
const base = { cwd: "/w", env: {}, signal };

describe("nativeSpawn", () => {
  test("a name the SDK reads as native is spawned as asked", () => {
    const spawn = { ...base, command: "/bin/claude", args: ["--print"] };
    expect(nativeSpawn("/bin/claude", spawn)).toEqual(spawn);
  });

  test("a name ending in .ts is still exec'd itself, never through bun", () => {
    const bin = "/a/bin/equin · conv-1 · fixture lacks pglite-cluster.ts";
    const spawn = {
      ...base,
      command: "bun",
      args: [bin, "--output-format", "stream-json"],
    };
    expect(nativeSpawn(bin, spawn)).toEqual({
      ...base,
      command: bin,
      args: ["--output-format", "stream-json"],
    });
  });

  test("a spawn without the executable in it is refused", () => {
    expect(() =>
      nativeSpawn("/bin/claude", { ...base, command: "bun", args: ["x.js"] }),
    ).toThrow(/spawn shape changed/);
  });
});
