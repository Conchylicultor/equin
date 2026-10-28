import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { stopGateHookEntry } from "./hook-entry";

describe("stopGateHookEntry", () => {
  test("runs the hook script beside this code, by absolute path", async () => {
    const entry = stopGateHookEntry();
    const path = /^bun "(.+)"$/.exec(entry.command)?.[1];
    expect(path).toBeDefined();
    expect(isAbsolute(path!)).toBe(true);
    expect(await Bun.file(path!).exists()).toBe(true);
    expect(path!.endsWith("/stop-gate/bin/stop-gate.ts")).toBe(true);
  });
});
