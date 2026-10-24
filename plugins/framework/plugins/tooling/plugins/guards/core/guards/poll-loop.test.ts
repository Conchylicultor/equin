import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { pollLoopGuard } from "./poll-loop";

const TASK_ID = "bjr1kagwr";
const TASK = `/private/tmp/claude-501/-Users-x--worktrees-att-1/abc/tasks/${TASK_ID}.output`;
/** A pid high enough that it cannot be live — drives the "finished" arm. */
const DEAD_PID = 2_147_483_646;

const sessions: string[] = [];
const scratch: string[] = [];
let counter = 0;

/** A fresh session id per case, so state never leaks between tests. */
function newSession(): string {
  const id = `guard-test-${process.pid}-${counter++}`;
  sessions.push(id);
  return id;
}

/** A throwaway directory, removed after the case. */
function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-poll-loop-test-"));
  scratch.push(dir);
  return dir;
}

/**
 * A transcript file holding the harness's completion notification for `taskId`.
 * Written to disk rather than faked, because what is under test is the guard
 * reading a REAL payload's `transcript_path`.
 */
function transcriptReporting(taskId: string): string {
  const path = join(newDir(), "session.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      message: {
        role: "user",
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`,
      },
    }),
  );
  return path;
}

function run(session: string, command: string, transcript?: string): Verdict {
  return pollLoopGuard.check(
    { command },
    createContext("/tmp", session, [], transcript),
  ) as Verdict;
}

/** Run a sequence and return the verdict of the last call. */
function runAll(commands: string[], transcript?: string): Verdict {
  const session = newSession();
  let last: Verdict = { kind: "allow" };
  for (const c of commands) last = run(session, c, transcript);
  return last;
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    rmSync(join(tmpdir(), `guard-poll-loop-${id}.json`), { force: true });
  }
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("poll-loop guard", () => {
  describe("the loop from conv-1786116592-b70n", () => {
    const polls = [25, 30, 35, 40].map(
      (n) =>
        `cat ${TASK} 2>/dev/null | tail -${n}; pgrep -f "singularity push" >/dev/null && echo running || echo finished`,
    );

    test("the first three looks are allowed", () => {
      const session = newSession();
      for (const p of polls.slice(0, 3))
        expect(run(session, p).kind).toBe("allow");
    });

    test("the fourth is denied even though every command differs", () => {
      expect(runAll(polls).kind).toBe("deny");
    });

    test("the denial tells the agent it will be notified", () => {
      const v = runAll(polls);
      expect(v.kind === "deny" && v.reason).toContain("re-invoked");
    });
  });

  describe("the loop from conv-1787490197-3p4n", () => {
    const idles = ["echo w1", "echo w2", "echo w3", "echo w4"];

    test("the fourth no-op is denied", () => {
      expect(runAll(idles).kind).toBe("deny");
    });

    test("the denial names the wait and tells the agent to end its turn", () => {
      const v = runAll(idles);
      expect(v.kind === "deny" && v.reason).toContain("only passes time");
      expect(v.kind === "deny" && v.reason).toContain("END YOUR TURN");
    });

    test("a bare sleep loop gets the same answer", () => {
      const v = runAll(["sleep 1", "sleep 2", "sleep 3", "sleep 4"]);
      expect(v.kind === "deny" && v.reason).toContain("only passes time");
    });

    test("ignoring the denial ends the turn", () => {
      const session = newSession();
      for (let i = 1; i <= 7; i++) run(session, `echo w${i}`);
      const v = run(session, "echo w8");
      expect(v.kind === "deny" && v.fatal).toBe(true);
    });
  });

  describe("what resets and what does not", () => {
    test("doing real work in between clears the window", () => {
      const session = newSession();
      run(session, `cat ${TASK}`);
      run(session, `cat ${TASK}`);
      run(session, `cat ${TASK}`);
      run(session, "./equin build");
      expect(run(session, `cat ${TASK}`).kind).toBe("allow");
    });

    test("an unrelated read-only command does not clear it", () => {
      expect(
        runAll([
          `cat ${TASK}`,
          "uptime",
          `cat ${TASK}`,
          "ls -la src",
          `cat ${TASK}`,
          `cat ${TASK}`,
        ]).kind,
      ).toBe("deny");
    });

    test("watching different things never accumulates", () => {
      expect(
        runAll([
          "cat /x/tasks/aaaaaaaaa.output",
          "cat /x/tasks/bbbbbbbbb.output",
          "cat /x/tasks/ccccccccc.output",
          "cat /x/tasks/ddddddddd.output",
        ]).kind,
      ).toBe("allow");
    });
  });

  describe("liveness picks the arm", () => {
    test("a live process is a wait — denied, told to end the turn", () => {
      const live = `ps -p ${process.pid} -o etime=`;
      const v = runAll([live, live, live, live]);
      expect(v.kind === "deny" && v.reason).toContain("END YOUR TURN");
    });

    test("a finished process is forensics — allowed, with the fact attached", () => {
      const dead = `ps -p ${DEAD_PID} -o etime=`;
      const v = runAll([dead, dead, dead, dead]);
      expect(v.kind).toBe("inform");
      expect(v.kind === "inform" && v.context).toContain("no longer changing");
    });
  });

  /**
   * The regression this suite exists for. An agent reads a finished run's
   * output four different ways — `tail`, then `grep`, then `sed` — and used to
   * be blocked and told it would be "re-invoked when it exits" by a harness
   * that had already woken it. 20 of 36 denials in a 30-day corpus were this.
   */
  describe("a background task's liveness comes from the transcript", () => {
    const looks = [
      `tail -30 ${TASK}`,
      `grep -n -i -E "fail|error" ${TASK}`,
      `sed -n '1,31p' ${TASK}`,
      `head -20 ${TASK}`,
    ];

    test("still running: denied, and told the wake-up is coming", () => {
      const empty = join(newDir(), "session.jsonl");
      writeFileSync(empty, "");
      const v = runAll(looks, empty);
      expect(v.kind).toBe("deny");
      expect(v.kind === "deny" && v.reason).toContain("re-invoked");
    });

    test("already reported: allowed, with the status attached", () => {
      const v = runAll(looks, transcriptReporting(TASK_ID));
      expect(v.kind).toBe("inform");
      expect(v.kind === "inform" && v.context).toContain("completed");
    });

    test("a reported task never escalates to a turn-ending denial", () => {
      // The escalation path turns a second loop on one subject into a fatal
      // deny. A finished task must never reach it however many times it is
      // read: from the 4th look on it stays an inform, indefinitely.
      const transcript = transcriptReporting(TASK_ID);
      const session = newSession();
      const kinds = Array.from(
        { length: 12 },
        (_, i) => run(session, `grep -c x${i} ${TASK}`, transcript).kind,
      );
      expect(kinds.slice(0, 3)).toEqual(["allow", "allow", "allow"]);
      expect(new Set(kinds.slice(3))).toEqual(new Set(["inform"]));
    });

    test("no transcript to read falls back to blocking, never to allowing", () => {
      // Not knowing must not be spent in the agent's favour: the pre-transcript
      // behaviour is the safe answer.
      expect(runAll(looks).kind).toBe("deny");
    });
  });

  describe("a file nothing is writing to is not a wait", () => {
    /** A log the guard has a watch subject for: `logs/<channel>.jsonl`. */
    function logFile(): string {
      const dir = join(newDir(), "logs");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "live-state.jsonl");
      writeFileSync(path, '{"t":1,"line":"x"}\n');
      return path;
    }

    /** An append, with an mtime a whole second on, so no clock granularity hides it. */
    function append(path: string, secondsOn: number): void {
      appendFileSync(path, '{"t":2,"line":"y"}\n');
      const when = new Date(Date.now() + secondsOn * 1000);
      utimesSync(path, when, when);
    }

    test("four questions about a log that stopped growing are answered", () => {
      const path = logFile();
      const v = runAll([
        `tail -40 ${path}`,
        `grep -c "sub-ack" ${path}`,
        `sed -E 's/x/y/' ${path}`,
        `head -5 ${path}`,
      ]);
      expect(v.kind).toBe("inform");
      expect(v.kind === "inform" && v.context).toContain("nothing has written");
    });

    test("a log being appended to between the looks is still a wait", () => {
      const path = logFile();
      const session = newSession();
      let last: Verdict = { kind: "allow" };
      for (let i = 1; i <= 4; i++) {
        last = run(session, `tail -${i}0 ${path}`);
        append(path, i);
      }
      expect(last.kind).toBe("deny");
    });

    test("waiting for a log that does not exist yet stays a wait", () => {
      const missing = join(newDir(), "logs", "build.jsonl");
      const v = runAll([
        `cat ${missing}`,
        `cat ${missing}`,
        `cat ${missing}`,
        `cat ${missing}`,
      ]);
      expect(v.kind).toBe("deny");
    });

    test("an empty log is a file waited FOR, not a result being read", () => {
      const dir = join(newDir(), "logs");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "build.jsonl");
      writeFileSync(path, "");
      const v = runAll([
        `cat ${path}`,
        `cat ${path}`,
        `cat ${path}`,
        `cat ${path}`,
      ]);
      expect(v.kind).toBe("deny");
    });
  });

  describe("escalation", () => {
    test("a second loop on the same subject ends the turn", () => {
      const session = newSession();
      const poll = `cat ${TASK}`;
      for (let i = 0; i < 4; i++) run(session, poll);
      // Denied once; ignoring that and polling the same subject again escalates.
      for (let i = 0; i < 3; i++) run(session, poll);
      const v = run(session, poll);
      expect(v.kind === "deny" && v.fatal).toBe(true);
    });
  });

  describe("ordinary commands are untouched", () => {
    test("a command watching nothing", () => {
      expect(
        runAll(["ls -la src", "ls -la src", "ls -la src", "ls -la src"]).kind,
      ).toBe("allow");
    });
  });
});
