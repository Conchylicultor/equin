import { describe, expect, test } from "bun:test";
import {
  crashFingerprint,
  type CrashPayload,
} from "@plugins/reports/plugins/crash/core";
import { SubjectError } from "@plugins/packages/plugins/error-subject/core";
import { bootCrashReport, stackRepoPaths } from "./boot-crash";

const ROOT = "/repo/wt";
const STACK = [
  `Error: allCollection("x"): the scope field "songId" is a decoded column`,
  `    at fail (${ROOT}/plugins/network/plugins/live/plugins/query-resource/server/internal/compile-alias.ts:283:15)`,
  `    at <anonymous> (${ROOT}/plugins/network/plugins/live/plugins/query-resource/server/internal/compile-alias.ts:912:7)`,
  `    at map (1:11)`,
  `    at parse (${ROOT}/node_modules/zod/index.js:10:2)`,
  `    at compiled (${ROOT}/plugins/network/plugins/live/server/internal/serve-collection.ts:1292:20)`,
  `    at bind (${ROOT}/plugins/network/plugins/live/plugins/resource-runtime/core/runtime.ts:4885:11)`,
  `    at elsewhere (/other/checkout/x.ts:1:1)`,
].join("\n");

describe("stackRepoPaths", () => {
  test("the first distinct repo files of the stack, dependencies and other roots skipped", () => {
    expect(stackRepoPaths(STACK, ROOT)).toEqual([
      "plugins/network/plugins/live/plugins/query-resource/server/internal/compile-alias.ts",
      "plugins/network/plugins/live/server/internal/serve-collection.ts",
      "plugins/network/plugins/live/plugins/resource-runtime/core/runtime.ts",
    ]);
  });

  test("a stack with no repo frame names no code", () => {
    expect(stackRepoPaths("Error: x\n    at map (1:11)", ROOT)).toEqual([]);
  });
});

describe("bootCrashReport", () => {
  test("a crash report naming the worktree and the error, typed by the error's name", () => {
    const err = new TypeError("boom");
    const report = bootCrashReport("wt-a", err, null);
    expect(report).toEqual({
      kind: "crash",
      message: "Backend of wt-a crashed during boot: boom",
      data: { errorType: "TypeError", stack: err.stack ?? null, scope: null },
    });
  });

  test("a non-Error throw is still reported with its text", () => {
    expect(bootCrashReport("wt-a", "plain", null).message).toBe(
      "Backend of wt-a crashed during boot: plain",
    );
  });

  test("with a branch point, the report carries it for the outbox's staleness rule", () => {
    const report = bootCrashReport("wt-a", new Error("x"), {
      mergeBase: "a".repeat(40),
    });
    expect(report.code?.mergeBase).toBe("a".repeat(40));
  });
});

describe("boot-crash identity", () => {
  // Every failed migration throws from the one runner frame: before the
  // error carried its subject, all of them shared one fingerprint
  // (report-1793851409-s559e6).
  const RUNNER_STACK = [
    "Error: migration failed",
    `    at runSteps (${ROOT}/plugins/database/plugins/migrations/server/internal/runner.ts:727:17)`,
    `    at async planAndRun (${ROOT}/plugins/database/plugins/migrations/server/internal/runner.ts:692:11)`,
    `    at async <anonymous> (${ROOT}/plugins/database/plugins/migrations/server/internal/runner.ts:780:46)`,
  ].join("\n");
  function migrationFailure(subject: string, code: string, worktree: string) {
    const err = new SubjectError(`migration ${subject} failed`, {
      subject,
      cause: Object.assign(new Error("pg"), { code }),
    });
    err.stack = RUNNER_STACK;
    return bootCrashReport(worktree, err, null);
  }
  async function fingerprintOf(r: ReturnType<typeof bootCrashReport>) {
    return crashFingerprint(r.data as CrashPayload, {
      message: r.message,
      source: "cli",
    });
  }

  test("two migrations failing through the same runner frames are two rows", async () => {
    const a = await fingerprintOf(
      migrationFailure(
        "migration page_links_first_edge (expand)",
        "42701",
        "wt-a",
      ),
    );
    const b = await fingerprintOf(
      migrationFailure(
        "migration reports_stale_origin_backfill (whole)",
        "42703",
        "wt-a",
      ),
    );
    expect(a).not.toBe(b);
  });

  test("one migration, two Postgres error classes: two rows", async () => {
    const s = "migration page_links_first_edge (expand)";
    expect(await fingerprintOf(migrationFailure(s, "42701", "wt-a"))).not.toBe(
      await fingerprintOf(migrationFailure(s, "55P03", "wt-a")),
    );
  });

  test("one cause in two worktrees is one row", async () => {
    const s = "migration page_links_first_edge (expand)";
    expect(await fingerprintOf(migrationFailure(s, "42701", "wt-a"))).toBe(
      await fingerprintOf(migrationFailure(s, "42701", "wt-b")),
    );
  });

  test("the subject is the report's scope", () => {
    expect(
      migrationFailure("migration x (expand)", "42701", "wt-a").data?.["scope"],
    ).toBe("migration x (expand) › code 42701");
  });
});
