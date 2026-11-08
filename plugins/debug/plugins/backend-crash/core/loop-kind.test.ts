import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  BackendCrashLoopPayloadSchema,
  CRASH_LOOP_RECENT_DEATHS,
  describeBackendCrashLoop,
  loopCausesOf,
} from "./loop-kind";

const GOLDEN = join(
  REPO_ROOT,
  "gateway/testdata/backend-crash-loop-entry.json",
);

describe("backend-crash-loop", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("backend-crash-loop");
    const d = BackendCrashLoopPayloadSchema.parse(entry.data);
    expect(d.state).toBe("ended");
    expect(loopCausesOf(d)).toBe("exit 1 ×2");
    expect(describeBackendCrashLoop(d)).toBe(
      "main crash-looped: 83 deaths in 29m 08s (last: exit 1); quiet since, now running",
    );
  });

  test("the bound on listed deaths is the Go writer's own", () => {
    const go = readFileSync(join(REPO_ROOT, "gateway/exit_report.go"), "utf8");
    const m = /const crashLoopRecentDeaths = (\d+)/.exec(go);
    expect(Number(m?.[1])).toBe(CRASH_LOOP_RECENT_DEATHS);
  });

  test("a loop still dying names its causes, most frequent first", () => {
    const d = BackendCrashLoopPayloadSchema.parse({
      worktree: "alpha",
      state: "looping",
      deaths: 3,
      firstDeathAt: 0,
      lastDeathAt: 20_000,
      endedAt: null,
      stateAtEnd: null,
      windowMs: 300_000,
      threshold: 3,
      recent: [
        { at: 0, upMs: 1_000, cause: "SIGSEGV", ready: false },
        { at: 10_000, upMs: 1_000, cause: "exit 1", ready: true },
        { at: 20_000, upMs: 1_000, cause: "exit 1", ready: true },
      ],
      lastStderrTail: [],
      lastStderrComplete: true,
    });
    expect(loopCausesOf(d)).toBe("exit 1 ×2, SIGSEGV ×1");
    expect(describeBackendCrashLoop(d)).toBe(
      "alpha is crash-looping: 3 deaths in 20.0s (last: exit 1)",
    );
  });
});
