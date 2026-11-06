import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { withEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core/testing";
import { openLandReport, takeLandPayload } from "./handoff";

const payload = {
  v: 1,
  pushId: "p-1",
  mode: "worktree",
  report: "/tmp/r.json",
};

describe("takeLandPayload", () => {
  test("no hand-off: not a land phase", async () => {
    await withEnv({ PUSH_LAND: undefined }, () => {
      expect(takeLandPayload()).toBeUndefined();
    });
  });

  test("reads the payload and takes it out of the env", async () => {
    await withEnv({ PUSH_LAND: JSON.stringify(payload) }, () => {
      expect(takeLandPayload()).toEqual({
        v: 1,
        pushId: "p-1",
        mode: "worktree",
        report: "/tmp/r.json",
      });
      // A descendant (the checks, a regen) must not inherit it.
      expect(readEnv("PUSH_LAND")).toBeUndefined();
    });
  });

  test("a version it does not know fails loudly", async () => {
    await withEnv({ PUSH_LAND: JSON.stringify({ ...payload, v: 2 }) }, () => {
      expect(() => takeLandPayload()).toThrow(/cannot read the hand-off/);
    });
  });
});

describe("openLandReport", () => {
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(path, "utf8"));

  test("is on disk from the start, steps land as they end, then the outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-land-"));
    const path = join(dir, "report.json");
    const report = openLandReport(path);
    expect(read(path)).toMatchObject({ v: 1, steps: [] });

    report.stepStart("checks");
    report.stepEnd("checks");
    expect(read(path)).toMatchObject({ steps: [{ name: "checks" }] });
    expect(read(path)).not.toHaveProperty("outcome");

    report.complete("failed_checks");
    expect(read(path)).toMatchObject({ outcome: "failed_checks" });
    // Written atomically: no temp file left beside it.
    expect(readdirSync(dir)).toEqual(["report.json"]);
  });

  test("ending a step that never started is a bug, not a silent no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-land-"));
    const report = openLandReport(join(dir, "report.json"));
    expect(() => report.stepEnd("normalize")).toThrow(/never started/);
  });
});
