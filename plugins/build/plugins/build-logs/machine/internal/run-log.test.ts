/**
 * The build's step-view fallback — what is left of `run-build.test.ts` after the
 * migration, and the one thing in it that is still build's own.
 *
 * That suite covered `readBuildTerminal`, the pid probe (now `isRunAlive`) and the `close?`
 * composition. All three now belong to the supervised-run primitive and are
 * tested there (`supervised-job/core/internal/terminal.test.ts`), against the
 * same real files and real pids — so keeping a second copy here would be two
 * suites asserting one rule, which is how they drift.
 *
 * What is genuinely build's is the OTHER half of `build-logs-<id>.json`: the
 * step transcript the UI renders, and what happens when a build died before
 * writing one. `recoverBuildArtifacts` used to reconstruct it from the parent's
 * pipe; the recovery is now a read over the child's own transcript, so this is
 * where it is pinned.
 *
 * Driven against real files at the real resolved paths, like the suite it
 * replaces — the module reads `runtimeNamespace()` at call time and cannot be
 * pointed at a fixture dir.
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import { BUILD_RUN_KIND_ID } from "@plugins/build/plugins/run-ledger/core";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import { buildRunLogs } from "../../core/run-logs";
import { readBuildRunLog, type BuildRunLog } from "./run-log";

const name = runtimeNamespace();
const created: string[] = [];

function uniqueBuildId(tag: string): string {
  return `test-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function write(path: string, contents: string): void {
  writeFileSync(path, contents);
  created.push(path);
}

/** The CLI's own step artifact, as `build-logs-writer` writes it. */
function writeStepArtifact(buildId: string, body: unknown): void {
  mkdirSync(worktreeDataDir(name), { recursive: true });
  write(
    worktreeArtifacts.buildLogs(name, buildId),
    JSON.stringify(body) + "\n",
  );
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

/** The log's steps with their lines folded back in, as the CLI wrote them. */
function stepsOf(log: BuildRunLog | null) {
  if (log === null) return null;
  return log.steps.map((step, index) => ({
    ...step,
    lines: log.lines
      .filter((l) => l.step === index)
      .map((l) => ({ text: l.text, stream: l.stream })),
  }));
}

async function steps(buildId: string) {
  return stepsOf(await readBuildRunLog(buildId));
}

describe("readBuildRunLog", () => {
  test("the CLI's own steps win whenever it wrote them", async () => {
    const buildId = uniqueBuildId("steps");
    const stepList = [
      {
        id: "install",
        label: "Install",
        lines: [],
        durationMs: 12,
        success: true,
      },
      { id: "vite", label: "Vite", lines: [], durationMs: 34, success: false },
    ];
    writeStepArtifact(buildId, {
      steps: stepList,
      finishedAt: Date.now(),
      exitCode: 1,
    });
    // Written too, to prove the artifact is preferred rather than merged.
    writeTranscript(buildId, "raw line\n");
    expect(await steps(buildId)).toEqual(
      stepList.map((s) => ({
        id: s.id,
        label: s.label,
        durationMs: s.durationMs,
        success: s.success,
        lines: s.lines,
      })),
    );
  });

  test("no artifact at all ⇒ the transcript, as one block", async () => {
    const buildId = uniqueBuildId("fallback");
    writeTranscript(buildId, "Restarting backend...\nboom\n");
    writeMarker(buildId, "137 -\n");
    const block = await steps(buildId);
    expect(block).toHaveLength(1);
    expect(block?.[0]?.label).toBe("Build Output");
    expect(block?.[0]?.lines.map((l) => l.text)).toEqual([
      "Restarting backend...",
      "boom",
    ]);
  });

  test("the block's verdict comes from the exit marker, not from a guess", async () => {
    const ok = uniqueBuildId("ok");
    writeTranscript(ok, "done\n");
    writeMarker(ok, "0 -\n");
    expect((await steps(ok))?.[0]?.success).toBe(true);

    const bad = uniqueBuildId("bad");
    writeTranscript(bad, "done\n");
    writeMarker(bad, "1 -\n");
    expect((await steps(bad))?.[0]?.success).toBe(false);
  });

  test("a hard kill — transcript but NO marker — is not shown as a success", async () => {
    // The case the whole fallback exists for: SIGKILL runs no shell, so nothing
    // wrote a marker and nothing ever will. The output is still there because
    // the child wrote it, but there is no verdict to claim.
    const buildId = uniqueBuildId("sigkill");
    writeTranscript(buildId, "half a build\n");
    expect((await steps(buildId))?.[0]?.success).toBe(false);
  });

  test("a final line with no newline is kept, not dropped", async () => {
    const buildId = uniqueBuildId("partial");
    writeTranscript(buildId, "first\nkilled mid-line");
    expect((await steps(buildId))?.[0]?.lines.map((l) => l.text)).toEqual([
      "first",
      "killed mid-line",
    ]);
  });

  test("an artifact with zero steps falls through to the transcript", async () => {
    // An abort can close no steps at all. The artifact exists and is valid, but
    // has nothing to render — so the raw output is strictly better than nothing.
    const buildId = uniqueBuildId("zerostep");
    writeStepArtifact(buildId, {
      steps: [],
      finishedAt: Date.now(),
      exitCode: 143,
    });
    writeTranscript(buildId, "the only evidence\n");
    expect((await steps(buildId))?.[0]?.lines).toHaveLength(1);
  });

  test("an unparseable artifact falls through rather than taking the pane down", async () => {
    const buildId = uniqueBuildId("garbage");
    mkdirSync(worktreeDataDir(name), { recursive: true });
    write(worktreeArtifacts.buildLogs(name, buildId), "{ not json");
    writeTranscript(buildId, "still readable\n");
    expect((await steps(buildId))?.[0]?.lines).toHaveLength(1);
  });

  test("neither file ⇒ no log, which is what makes the pane show the live log", async () => {
    expect(await readBuildRunLog(uniqueBuildId("absent"))).toBeNull();
  });

  test("an empty transcript is no log, not an empty block", async () => {
    const buildId = uniqueBuildId("empty");
    writeTranscript(buildId, "");
    expect(await readBuildRunLog(buildId)).toBeNull();
  });

  test("lines are numbered over the whole run, each naming its step by position", async () => {
    const buildId = uniqueBuildId("numbered");
    const line = (text: string) => ({ text, stream: "stdout" as const });
    // Two steps sharing an id — the CLI's implicit `output` step reopened.
    writeStepArtifact(buildId, {
      steps: [
        {
          id: "output",
          label: "Output",
          lines: [line("a"), line("b")],
          durationMs: 1,
          success: true,
        },
        {
          id: "vite",
          label: "Vite",
          lines: [line("c")],
          durationMs: 2,
          success: false,
        },
        {
          id: "output",
          label: "Output",
          lines: [line("d")],
          durationMs: 3,
          success: true,
        },
      ],
      finishedAt: Date.now(),
      exitCode: 1,
    });
    const log = await readBuildRunLog(buildId);
    expect(log?.lines.map((l) => [l.n, l.step, l.text])).toEqual([
      ["000000001", 0, "a"],
      ["000000002", 0, "b"],
      ["000000003", 1, "c"],
      ["000000004", 2, "d"],
    ]);
    expect(log?.steps.map((s) => s.lines)).toEqual([2, 1, 1]);
  });

  test("pages within buildRunLogs' key contract (newest first)", async () => {
    const buildId = uniqueBuildId("paged");
    writeTranscript(
      buildId,
      Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    );
    const log = await readBuildRunLog(buildId);
    if (log === null) throw new Error("the transcript should read as a log");
    const items = log.lines;
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
