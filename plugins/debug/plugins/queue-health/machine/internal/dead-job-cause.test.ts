import { describe, expect, test } from "bun:test";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import {
  deadJobCause,
  deadJobFingerprint,
  foldDeadJobsByCause,
} from "./dead-job-cause";

const crashed = (runId: string, attempt: number) =>
  `[supervised-job] worktree.prepare: run ${runId} exited 1 on attempt ${attempt}/${attempt}: ` +
  "killed or crashed before recording an error — see the transcript";
const raced = (runId: string) =>
  `[supervised-job] worktree.prepare: run ${runId} exited 1 on attempt 1/1: tuple concurrently updated`;

// The shape the supervised-job ledger dead-letters a child that recorded no
// error with: a long prefix, then its transcript's end — the cause.
const quoted = (runId: string, end: string) =>
  `[supervised-job] worktree.prepare: run ${runId} exited 1 on attempt 1/1: ` +
  `recorded no error; its transcript (${worktreeArtifacts.runTranscript(
    asNamespace("att-1793774008-dn3qb8"),
    "worktreeprepare",
    runId,
  )}) ends:\n` +
  end;
const fsWaitEnd =
  'error: [fs-wait] this process already records its file waits as "cli supervised-exec", not "exec"\n' +
  "      at recordFsWaits (/repo/plugins/debug/plugins/profiling/plugins/fs-wait/server/internal/record-fs-waits.ts:68:15)";
const raceEnd =
  "error: tuple concurrently updated\n" +
  "      at setIdleInTransactionTimeout (/repo/plugins/database/machine/internal/pg-driver.ts:120:7)";

const row = (lastError: string | null, jobName = "worktree.prepare") => ({
  jobName,
  lastError,
  deadCount: 1,
  attempts: 1,
  maxAttempts: 1,
  sampleJobId: "1",
});

const fingerprint = (lastError: string | null, jobName = "worktree.prepare") =>
  deadJobFingerprint(row(lastError, jobName));

describe("a dead job is identified by its cause", () => {
  test("one cause across runs and attempts is one identity", () => {
    expect(
      deadJobCause(crashed("87ec920f-9da0-4cd5-b233-b8e3952b47d7", 1)),
    ).toBe(deadJobCause(crashed("adacbeea-8feb-481d-9593-e3ff7ca3cda0", 5)));
  });

  // The 2026-11-04 incident: a new cause of `worktree.prepare` deaths filed
  // onto the report of an older, unrelated one.
  test("a new cause of the same job gets its own report", () => {
    const old = fingerprint(crashed("87ec920f-9da0-4cd5-b233-b8e3952b47d7", 1));
    const fresh = fingerprint(raced("c45359c0-3b3c-481a-b8e7-e2fe1d2ba0dc"));
    expect(fresh).not.toBe(old);
    expect(fresh.startsWith("queue-dead-job:worktree.prepare:")).toBe(true);
  });

  test("a cause quoted from the transcript's end, past a long prefix, still tells deaths apart", () => {
    const a = "87ec920f-9da0-4cd5-b233-b8e3952b47d7";
    const b = "3c9d8438-01a3-4336-94c2-62beff607ddb";
    expect(fingerprint(quoted(a, fsWaitEnd))).toBe(
      fingerprint(quoted(b, fsWaitEnd)),
    );
    expect(fingerprint(quoted(a, fsWaitEnd))).not.toBe(
      fingerprint(quoted(b, raceEnd)),
    );
  });

  test("the same cause of two jobs stays two reports", () => {
    const e = "boom";
    expect(fingerprint(e, "a.job")).not.toBe(fingerprint(e, "b.job"));
  });

  test("the fold merges exact-text groups of one cause, and only those", () => {
    const folded = foldDeadJobsByCause([
      row(raced("87ec920f-9da0-4cd5-b233-b8e3952b47d7")),
      {
        ...row(raced("c45359c0-3b3c-481a-b8e7-e2fe1d2ba0dc")),
        attempts: 3,
        deadCount: 2,
      },
      row(crashed("adacbeea-8feb-481d-9593-e3ff7ca3cda0", 1)),
      row(null),
      row(raced("87ec920f-9da0-4cd5-b233-b8e3952b47d7"), "other.job"),
    ]);
    expect(folded.map((g) => [g.jobName, g.deadCount, g.attempts])).toEqual([
      ["worktree.prepare", 3, 3],
      ["worktree.prepare", 1, 1],
      ["worktree.prepare", 1, 1],
      ["other.job", 1, 1],
    ]);
  });
});
