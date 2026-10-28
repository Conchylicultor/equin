import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { compactionHookEntry } from "./hook-entry";

describe("compactionHookEntry", () => {
  test("runs the hook script beside this code, by absolute path", async () => {
    const entry = compactionHookEntry();
    const path = /^bun "(.+)"$/.exec(entry.command)?.[1];
    expect(path).toBeDefined();
    expect(isAbsolute(path!)).toBe(true);
    expect(await Bun.file(path!).exists()).toBe(true);
    expect(
      path!.endsWith("/compaction-context/bin/compaction-context.ts"),
    ).toBe(true);
  });
});
