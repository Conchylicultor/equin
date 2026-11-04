/**
 * The build pane's read of a run: its supervised-run transcript cut into the
 * step blocks the build printed and the output between them, with the exit
 * marker deciding where a failed run failed.
 *
 * Driven against real files at the real resolved paths — the module reads
 * `runtimeNamespace()` at call time and cannot be pointed at a fixture dir. The
 * blocks are spelled as a real transcript carries them; the format's own
 * render/parse round trip is pinned beside it (op-runtime `step-blocks.test.ts`).
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/server";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import { buildRunLogs } from "../../core/run-logs";
import { readBuildRunLog } from "./run-log";

const name = runtimeNamespace();
const created: string[] = [];

function uniqueBuildId(tag: string): string {
  return `test-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function write(path: string, contents: string): void {
  writeFileSync(path, contents);
  created.push(path);
}

/** The supervised run's transcript, as the child's own fd writes it. */
function writeTranscript(buildId: string, text: string): void {
  mkdirSync(worktreeArtifacts.runsDir(name), { recursive: true });
  write(
    worktreeArtifacts.runTranscript(name, BUILD_RUN_KIND_ID, buildId),
    text,
  );
}

/** The exit marker, as the supervised-run shim writes it. */
function writeMarker(buildId: string, body: string): void {
  mkdirSync(worktreeArtifacts.runsDir(name), { recursive: true });
  write(worktreeArtifacts.runTerminal(name, BUILD_RUN_KIND_ID, buildId), body);
}

afterEach(() => {
  for (const path of created.splice(0)) {
    if (existsSync(path)) rmSync(path);
  }
});

/** One printed step block, as a build's transcript carries it. */
function block(
  label: string,
  success: boolean,
  durationMs: number,
  lines: string[],
): string[] {
  const header = `── ${label} ${success ? "✓" : "✗"} (${(durationMs / 1000).toFixed(1)}s) `;
  return [
    header + "─".repeat(Math.max(0, 60 - header.length)),
    ...lines.map((l) => `│ ${l}`),
  ];
}

function transcript(lines: string[]): string {
  return lines.join("\n") + "\n";
}

async function read(buildId: string) {
  const log = await readBuildRunLog(buildId);
  if (log === null) throw new Error("the transcript should read as a log");
  return log;
}

/** Each step with its own lines' texts. */
async function steps(buildId: string) {
  const log = await read(buildId);
  return log.steps.map((step, index) => ({
    ...step,
    texts: log.lines.filter((l) => l.step === index).map((l) => l.text),
  }));
}

describe("readBuildRunLog", () => {
  test("every line is kept: the blocks, and the output between them", async () => {
    const buildId = uniqueBuildId("whole");
    writeTranscript(
      buildId,
      transcript([
        "Generating plugin registry...",
        ...block("checks", true, 25834, ["• boundary-rules ... ok"]),
        ...block("web artifacts", true, 25756, ["compose: 2281 links"]),
        "Restarting backend...",
        "Backend restart returned 500",
      ]),
    );
    writeMarker(buildId, "1 -\n");
    expect(await steps(buildId)).toEqual([
      {
        label: "output",
        status: "ok",
        durationMs: null,
        lines: 1,
        texts: ["Generating plugin registry..."],
      },
      {
        label: "checks",
        status: "ok",
        durationMs: 25800,
        lines: 1,
        texts: ["• boundary-rules ... ok"],
      },
      {
        label: "web artifacts",
        status: "ok",
        durationMs: 25800,
        lines: 1,
        texts: ["compose: 2281 links"],
      },
      // The run failed outside every block: its last stretch is the failure.
      {
        label: "output",
        status: "failed",
        durationMs: null,
        lines: 2,
        texts: ["Restarting backend...", "Backend restart returned 500"],
      },
    ]);
  });

  test("a failed block is the failure, and the run's last stretch stays ok", async () => {
    const buildId = uniqueBuildId("failedblock");
    writeTranscript(
      buildId,
      transcript([
        ...block("checks", false, 1000, ["✗ type-check"]),
        "BUILD FAILED",
      ]),
    );
    writeMarker(buildId, "1 -\n");
    expect((await steps(buildId)).map((s) => s.status)).toEqual([
      "failed",
      "ok",
    ]);
  });

  test("a succeeded run is ok throughout", async () => {
    const buildId = uniqueBuildId("ok");
    writeTranscript(
      buildId,
      transcript(["a", ...block("checks", true, 1, []), "BUILD OK"]),
    );
    writeMarker(buildId, "0 -\n");
    expect((await steps(buildId)).map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });

  test("no marker ⇒ the run is still in its last stretch", async () => {
    const buildId = uniqueBuildId("running");
    writeTranscript(
      buildId,
      transcript(["a", ...block("checks", true, 1, []), "b"]),
    );
    expect((await steps(buildId)).map((s) => s.status)).toEqual([
      "ok",
      "ok",
      "running",
    ]);
  });

  test("a final line with no newline is kept, not dropped", async () => {
    const buildId = uniqueBuildId("partial");
    writeTranscript(buildId, "first\nkilled mid-line");
    expect((await steps(buildId))[0]?.texts).toEqual([
      "first",
      "killed mid-line",
    ]);
  });

  test("no transcript ⇒ no log, refused as missing by the value", async () => {
    expect(await readBuildRunLog(uniqueBuildId("absent"))).toBeNull();
  });

  test("an empty transcript is a log with nothing in it yet", async () => {
    const buildId = uniqueBuildId("empty");
    writeTranscript(buildId, "");
    expect(await read(buildId)).toEqual({ steps: [], lines: [] });
  });

  test("lines are numbered over the whole run, each naming its step by position", async () => {
    const buildId = uniqueBuildId("numbered");
    writeTranscript(
      buildId,
      transcript(["a", "b", ...block("vite", false, 2, ["c"]), "d"]),
    );
    const log = await read(buildId);
    expect(log.lines.map((l) => [l.n, l.step, l.text])).toEqual([
      ["000000001", 0, "a"],
      ["000000002", 0, "b"],
      ["000000003", 1, "c"],
      ["000000004", 2, "d"],
    ]);
    expect(log.steps.map((s) => s.lines)).toEqual([2, 1, 1]);
  });
  test("pages within buildRunLogs' key contract (newest first)", async () => {
    const buildId = uniqueBuildId("paged");
    writeTranscript(
      buildId,
      Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    );
    const items = (await read(buildId)).lines;
    expect(items).toHaveLength(12);
    await checkPagedSource({
      value: buildRunLogs,
      query: { id: buildId },
      loader: (_q, range) => sliceRange(buildRunLogs, items, range),
      items,
      limits: [1, 5],
    });
    const page0 = sliceRange(buildRunLogs, items, {
      after: null,
      until: null,
      limit: 3,
    });
    expect(page0.map((l) => l.text)).toEqual(["line 12", "line 11", "line 10"]);
  });
});
