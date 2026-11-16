import { describe, expect, test } from "bun:test";
import { parseStepBlocks } from "@plugins/framework/plugins/cli/plugins/op-runtime/core";
import {
  buildFailureOf,
  buildFailureSignature,
  normalizeErrorLine,
} from "./failure";

// Shapes cut from real failed builds of main (runs/build-<id>.log).

const CHECKS_FAILED = [
  "── web artifacts ✓ (7.4s) ──────────────────────────────────",
  "│ detect: 950 web artifacts",
  "── checks ✗ (12.3s) ────────────────────────────────────────",
  "│ • active-data:no-adhoc-inline-code ... ok (cached)",
  "│ • type-check ... FAIL",
  "│   TypeScript type errors:",
  "│   plugins/apps/plugins/isle/plugins/renderer/web/internal/engine.ts:1710:23 - error TS2339: Property 'sx' does not exist on type 'never'.",
  "│ • logo:files-in-sync ... FAIL (shared with run chk-1)",
  "│ Full check output: /x/check.log",
  "build orchestrator: peak footprint 3.0 GB",
  "",
  "╔══════╗",
  "║  BUILD FAILED — checks ║",
  "╚══════╝",
];

const STEP_ERROR = [
  "── web artifacts ✗ (7.0s) ──────────────────────────────────",
  "│ detect: 950 web artifacts (1 stale), entry cached, registry stale",
  '│ Error: crawl snapshot "website": plugins/apps/plugins/website/plugins/crawlable/bin/static-host.ts exited 1 without writing anything',
  "│ --- stderr ---",
  "│ SnapshotPageError: [crawlable] page /about: scoped-store: hook used outside its <Provider>",
  "╔══════╗",
];

const CRASH = [
  "Generating plugin registry...",
  "175 |   if (failures.length > 0) {",
  "176 |     throw new Error(",
  "                    ^",
  "error: 1 check contribution(s) failed to load:",
  "    apps/plugins/website/plugins/crawlable — loader threw: Export named 'takeCrawlSnapshot' not found",
  "      at loadCollectedDirEntries (/opt/checkout/plugins/framework/x.ts:176:15)",
  "",
  "╔══════════════════╗",
  "║  BUILD FAILED — crashed before completing (exit 1) ║",
  "╚══════════════════╝",
  "  The build threw an unhandled exception before printing its own verdict:",
  "    Error: 1 check contribution(s) failed to load:",
];

const ABORT = [
  "Generating plugins doc...",
  "ERROR: this build changed files git tracks on main.",
  "",
  "Main's checkout is read-only to its own build: every generated file here was",
  "   M docs/plugins-details.md",
  "╔═════╗",
  "║  BUILD FAILED — aborted before completing (exit 1) ║",
];

describe("buildFailureOf", () => {
  test("a failed checks step: its failing check ids, deduped on them alone", () => {
    const f = buildFailureOf(parseStepBlocks(CHECKS_FAILED));
    expect(f.step).toBe("checks");
    expect(f.checks).toEqual(["type-check", "logo:files-in-sync"]);
    expect(buildFailureSignature({ ...f, noTranscript: false })).toBe(
      "checks: logo:files-in-sync, type-check",
    );
  });

  test("a failed step with no checks: its first error line", () => {
    const f = buildFailureOf(parseStepBlocks(STEP_ERROR));
    expect(f.step).toBe("web artifacts");
    expect(f.checks).toEqual([]);
    expect(f.error).toBe(
      'Error: crawl snapshot "website": plugins/apps/plugins/website/plugins/crawlable/bin/static-host.ts exited 1 without writing anything',
    );
  });

  test("a crash before the verdict: the uncaught error line, not the source excerpt", () => {
    const f = buildFailureOf(parseStepBlocks(CRASH));
    expect(f.step).toBeNull();
    expect(f.error).toBe("error: 1 check contribution(s) failed to load:");
    // Cut at the banner: the verdict's restatement is not the tail.
    expect(f.tail.at(-1)).toContain("at loadCollectedDirEntries");
  });

  test("an abort before the verdict: the build's own ERROR line", () => {
    const f = buildFailureOf(parseStepBlocks(ABORT));
    expect(f.step).toBeNull();
    expect(f.error).toBe("ERROR: this build changed files git tracks on main.");
  });

  test("no transcript lines at all", () => {
    const f = buildFailureOf(parseStepBlocks([]));
    expect(f).toEqual({ step: null, checks: [], error: null, tail: [] });
    expect(buildFailureSignature({ ...f, noTranscript: true })).toBe(
      "outside any step: no transcript",
    );
  });
});

describe("buildFailureSignature", () => {
  test("the same failure on another commit and checkout reads alike", () => {
    const a = normalizeErrorLine(
      "Error: boom at /opt/repo/plugins/x/y.ts:12:3 (commit 856db56fbb)",
    );
    const b = normalizeErrorLine(
      "Error: boom at /opt/repo/.claude/worktrees/att-1/plugins/x/y.ts:40:9 (commit 393de40762)",
    );
    expect(a).toBe(b);
  });

  test("a different step or check is a different report", () => {
    const base = { checks: [], error: null, noTranscript: false };
    expect(buildFailureSignature({ ...base, step: "checks" })).not.toBe(
      buildFailureSignature({ ...base, step: "web artifacts" }),
    );
    expect(
      buildFailureSignature({ ...base, step: "checks", checks: ["a"] }),
    ).not.toBe(
      buildFailureSignature({ ...base, step: "checks", checks: ["b"] }),
    );
  });
});
