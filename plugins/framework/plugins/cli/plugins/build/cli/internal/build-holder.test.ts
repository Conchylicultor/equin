import { expect, test } from "bun:test";
import type { BuildRunProgress } from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { buildHolderObservation } from "./build-holder";

const files = { progress: "build-progress.jsonl", opLog: "op-log.jsonl" };

const run = (over: Partial<BuildRunProgress> = {}): BuildRunProgress => ({
  runId: "r1",
  pid: 42,
  worktree: "att-test",
  buildId: "build-1",
  startedAt: "2026-09-16T22:00:08.414Z",
  lastActivityAt: "2026-09-16T22:16:39.799Z",
  lastAdvanceAt: "2026-09-16T22:02:03.911Z",
  peakRssMb: 934,
  outstanding: [
    {
      label: "wait for host CPU grant",
      startedAt: "2026-09-16T22:02:03.911Z",
      elapsedMs: 0,
      rssMb: 934,
    },
  ],
  done: null,
  ...over,
});

test("no live run is unknown — nothing proves what the holder is doing", () => {
  expect(buildHolderObservation(undefined, null, files)).toEqual({
    kind: "unknown",
  });
  const finished = run({
    done: {
      at: "2026-09-16T22:27:19.611Z",
      success: false,
      elapsedMs: 1,
      peakRssMb: 1,
    },
  });
  expect(buildHolderObservation(finished, null, files).kind).toBe("unknown");
});

test("an open declared wait is waiting (the 2026-09-16 host-grant queue)", () => {
  const obs = buildHolderObservation(
    run(),
    {
      kind: "host-grant",
      startMs: 115_453,
      startedAt: "2026-09-16T22:02:03.914Z",
      reason: null,
      cycle: 0,
    },
    files,
  );
  expect(obs).toEqual({
    kind: "waiting",
    wait: "host-grant",
    since: Date.parse("2026-09-16T22:02:03.914Z"),
    evidence: "op-log.jsonl",
  });
});

test("no open wait is working, judged by the last step boundary", () => {
  const obs = buildHolderObservation(
    run({
      outstanding: [
        { label: "web artifacts", startedAt: "x", elapsedMs: 0, rssMb: 1 },
      ],
    }),
    null,
    files,
  );
  expect(obs).toEqual({
    kind: "working",
    step: "web artifacts",
    lastAdvanceAt: Date.parse("2026-09-16T22:02:03.911Z"),
    evidence: "build-progress.jsonl",
  });
});
