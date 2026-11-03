import { describe, expect, test } from "bun:test";
import { bootCrashReport, stackRepoPaths } from "./boot-crash";

const ROOT = "/repo/wt";
const STACK = [
  `Error: allCollection("x"): the scope field "songId" is a decoded column`,
  `    at fail (${ROOT}/plugins/infra/plugins/query-resource/server/internal/compile-alias.ts:283:15)`,
  `    at <anonymous> (${ROOT}/plugins/infra/plugins/query-resource/server/internal/compile-alias.ts:912:7)`,
  `    at map (1:11)`,
  `    at parse (${ROOT}/node_modules/zod/index.js:10:2)`,
  `    at compiled (${ROOT}/plugins/network/plugins/live/server/internal/serve-collection.ts:1292:20)`,
  `    at bind (${ROOT}/plugins/framework/plugins/resource-runtime/core/runtime.ts:4885:11)`,
  `    at elsewhere (/other/checkout/x.ts:1:1)`,
].join("\n");

describe("stackRepoPaths", () => {
  test("the first distinct repo files of the stack, dependencies and other roots skipped", () => {
    expect(stackRepoPaths(STACK, ROOT)).toEqual([
      "plugins/infra/plugins/query-resource/server/internal/compile-alias.ts",
      "plugins/network/plugins/live/server/internal/serve-collection.ts",
      "plugins/framework/plugins/resource-runtime/core/runtime.ts",
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
      data: { errorType: "TypeError", stack: err.stack ?? null },
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
