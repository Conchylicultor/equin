import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { compactionHookEntry } from "./hook-entry";

describe("compactionHookEntry", () => {
  test("runs the hook script in this checkout through the launcher, both by absolute path", async () => {
    const entry = await compactionHookEntry();
    const [, launcher, path] =
      /^\/bin\/sh "([^"]+)" "([^"]+)"$/.exec(entry.command) ?? [];
    expect(path).toBeDefined();
    expect(await Bun.file(launcher!).exists()).toBe(true);
    expect(isAbsolute(path!)).toBe(true);
    expect(await Bun.file(path!).exists()).toBe(true);
    expect(
      path!.endsWith("/compaction-context/bin/compaction-context.ts"),
    ).toBe(true);
  });
});
