import { describe, expect, test } from "bun:test";
import { readDryRun } from "./playwright-browser";

// Output shapes copied from playwright-core 1.65's reportMissingDependenciesLinux.
describe("readDryRun", () => {
  test("all installed is present", () => {
    expect(readDryRun(0, "All system dependencies are installed.\n")).toEqual({
      kind: "present",
    });
  });

  test("the missing list is read package by package", () => {
    const out =
      "Missing system dependencies (3):\n  libasound2t64\n  libatk1.0-0t64\n  libgbm1\n";
    expect(readDryRun(1, out)).toEqual({
      kind: "missing",
      packages: ["libasound2t64", "libatk1.0-0t64", "libgbm1"],
    });
  });

  test("an apt simulation that failed is unknown, never present", () => {
    const out =
      "Failed to install browser dependencies\nError: 'apt-get install -s' exited with code 100:\nE: Unable to locate package libgbm1\n";
    const read = readDryRun(1, out);
    expect(read.kind).toBe("unknown");
  });

  test("exit 0 without the all-installed line is unknown", () => {
    expect(readDryRun(0, "").kind).toBe("unknown");
  });
});
