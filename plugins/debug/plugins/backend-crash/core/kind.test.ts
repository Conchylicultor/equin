import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  BackendCrashPayloadSchema,
  CRASH_LINE_MAX_BYTES,
  CRASH_TAIL_LINES,
  bunPanicOf,
  describeBackendCrash,
  macCrashReportGlob,
} from "./kind";

// The entry the gateway's Go writer produces (its own test asserts it builds
// exactly this): the cross-language contract, read by both sides.
const GOLDEN = join(REPO_ROOT, "gateway/testdata/backend-crash-entry.json");

describe("backend-crash", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("backend-crash");
    const d = BackendCrashPayloadSchema.parse(entry.data);
    expect(d.signal).toBe("SIGSEGV");
    expect(bunPanicOf(d)).toEqual({
      panic: "panic: Segmentation fault at address 0x7BC138",
      reportUrl:
        "https://bun.report/1.4.4/Ma138afee6i3FuhooC__________A2AwzgvP",
    });
    expect(describeBackendCrash(d)).toBe(
      "alpha died by SIGSEGV after 1h 05m — panic: Segmentation fault at address 0x7BC138",
    );
    expect(macCrashReportGlob(d)).toBe(
      "~/Library/Logs/DiagnosticReports{,/Retired}/equin · server · alpha-*.ips",
    );
  });

  test("the bounds are the Go writer's own", () => {
    const go = readFileSync(join(REPO_ROOT, "gateway/crash_report.go"), "utf8");
    const constant = (name: string): number => {
      const m = new RegExp(`const ${name} = (\\d+)`).exec(go);
      if (!m) throw new Error(`gateway/crash_report.go declares no ${name}`);
      return Number(m[1]);
    };
    expect(constant("crashTailLines")).toBe(CRASH_TAIL_LINES);
    expect(constant("crashLineMaxBytes")).toBe(CRASH_LINE_MAX_BYTES);
    const suffix = /const lineCutSuffix = "(.*)"/.exec(go)?.[1];
    expect(Buffer.byteLength(suffix ?? "")).toBeLessThanOrEqual(9);
  });

  test("a tail without Bun's block describes the signal alone", () => {
    const d = BackendCrashPayloadSchema.parse({
      worktree: "central",
      pid: 7,
      signal: "SIGKILL",
      signalNumber: 9,
      coreDumped: false,
      startedAt: 0,
      exitedAt: 42_000,
      executable: "bun",
      stderrTail: ["[boot] something"],
      stderrComplete: true,
    });
    expect(bunPanicOf(d)).toEqual({ panic: null, reportUrl: null });
    expect(describeBackendCrash(d)).toBe("central died by SIGKILL after 42.0s");
  });
});
