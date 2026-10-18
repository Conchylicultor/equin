import { describe, expect, test } from "bun:test";
import {
  parseTmuxStamp,
  resolveSessionState,
  routeSessionFile,
  type PaneRef,
  type SessionAnomaly,
  type SessionFileDeps,
} from "./claude-session";
import { captureProcessTree, type ProcessTree } from "./process-tree";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-09T12:00:00Z");

const WT = "/wt";
const OTHER_WT = "/other-wt";

interface Entry {
  json: Record<string, unknown>;
  mtimeMs: number;
}

/** The anomalies one resolution emitted, in order. */
type AnomalyLog = SessionAnomaly[];

/** Session files keyed by pid; a pid with no entry behaves as ENOENT. */
function depsOf(
  files: Record<number, Entry>,
  anomalies: AnomalyLog = [],
): SessionFileDeps {
  return {
    readSessionFile: (pid) => {
      const entry = files[pid];
      return Promise.resolve(entry ? JSON.stringify(entry.json) : null);
    },
    statSessionFile: (pid) => Promise.resolve(files[pid]?.mtimeMs ?? null),
    listSessionPids: () => Promise.resolve(Object.keys(files).map(Number)),
    reportAnomaly: (anomaly) => {
      anomalies.push(anomaly);
    },
  };
}

/** The pane under test: pid, its immutable `%pane_id`, and its worktree. */
function paneOf(panePid: number, paneId = "%1", worktreePath = WT): PaneRef {
  return { panePid, paneId, worktreePath };
}

/** A linear process chain; every pid in it is live. */
function chain(...pids: number[]): ProcessTree {
  const children = new Map<number, number[]>();
  for (let i = 1; i < pids.length; i++) children.set(pids[i - 1]!, [pids[i]!]);
  return { children, pids: new Set(pids) };
}

/**
 * Declare pids live without parenting them into the pane's subtree — a parked
 * job's host is re-parented to launchd, so it is live but unreachable from the
 * pane.
 */
function alsoLive(tree: ProcessTree, ...pids: number[]): ProcessTree {
  for (const pid of pids) tree.pids.add(pid);
  return tree;
}

/** A session file stamped as belonging to `paneId`. */
function stamp(paneId: string): string {
  return `conv-1787129489-vnbm:@3466.${paneId}`;
}

function kinds(anomalies: AnomalyLog): string[] {
  return anomalies.map((a) => a.kind);
}

/**
 * Await a promise expected to reject and hand back its Error.
 *
 * `expect(p).rejects.toThrow()` is typed `void` by bun's matchers even though it
 * returns a promise, so awaiting it trips `@typescript-eslint/await-thenable`.
 * Capturing the rejection directly is honest to the types, and a promise that
 * resolves fails loudly here rather than passing a vacuous assertion.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("resolveSessionState — the claim rule", () => {
  test("healthy pane: the record stamping this pane wins however old it is", async () => {
    // Most live sessions look like this. An idle interactive session can go
    // weeks without a write, so age alone must never disqualify a claimant.
    const deps = depsOf({
      99082: {
        json: {
          sessionId: "4a4671db",
          status: "idle",
          waitingFor: null,
          tmux: stamp("%1"),
          cwd: WT,
          kind: "interactive",
        },
        mtimeMs: NOW - 58 * DAY_MS,
      },
    });
    const state = await resolveSessionState(paneOf(99082), chain(99082), deps);
    expect(state).toEqual({
      sessionId: "4a4671db",
      status: "idle",
      waitingFor: null,
      statusUpdatedAt: null,
    });
  });

  test("the CLI's statusUpdatedAt is read through", async () => {
    const deps = depsOf({
      99082: {
        json: {
          sessionId: "4a4671db",
          status: "busy",
          statusUpdatedAt: NOW - 5_000,
          tmux: stamp("%1"),
          cwd: WT,
          kind: "interactive",
        },
        mtimeMs: NOW - 5_000,
      },
    });
    const state = await resolveSessionState(paneOf(99082), chain(99082), deps);
    expect(state.statusUpdatedAt).toBe(NOW - 5_000);
  });

  test("1. the record stamping %1 beats a fresher one stamping %2", async () => {
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: {
            sessionId: "mine",
            status: "idle",
            tmux: stamp("%1"),
            cwd: WT,
          },
          mtimeMs: NOW - DAY_MS,
        },
        2: {
          json: {
            sessionId: "theirs",
            status: "busy",
            tmux: stamp("%2"),
            cwd: OTHER_WT,
          },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(paneOf(1), chain(1, 2), deps);
    expect(state.sessionId).toBe("mine");
    // The stranger was fresher — the pre-claim rule would have adopted it.
    expect(kinds(anomalies)).toEqual(["foreign-session-outranked"]);
  });

  test("2. the live 2026-08-19 incident: the lent daemon spare never wins", async () => {
    // The real tree. Claude Code runs ONE background daemon per machine, and it
    // lends pre-warmed spares to any conversation — so 27571 belongs to a
    // different agent in a different worktree while sitting in THIS subtree.
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        9948: {
          json: {
            sessionId: "9fd24c8e",
            status: "idle",
            cwd: WT,
            kind: "interactive",
            tmux: stamp("%3429"),
            parkedJobId: "baf9c302",
          },
          mtimeMs: Date.parse("2026-08-18T13:05:00Z"),
        },
        // The parked job's host: re-parented to launchd, outside the subtree.
        11536: {
          json: {
            sessionId: "baf9c302-68bf",
            status: "idle",
            cwd: WT,
            kind: "bg",
            jobId: "baf9c302",
          },
          mtimeMs: Date.parse("2026-08-18T13:20:00Z"),
        },
        // The borrowed spare: fresher than everything, foreign cwd, kind "bg".
        27571: {
          json: {
            sessionId: "2bf76e71",
            status: "idle",
            cwd: OTHER_WT,
            kind: "bg",
            jobId: "2bf76e71",
          },
          mtimeMs: Date.parse("2026-08-19T03:17:00Z"),
        },
      },
      anomalies,
    );
    const tree = alsoLive(chain(9948, 27243, 27538, 27571), 11536);
    const state = await resolveSessionState(
      paneOf(9948, "%3429", WT),
      tree,
      deps,
    );
    expect(state.sessionId).toBe("baf9c302-68bf");
    expect(kinds(anomalies)).toEqual(["foreign-session-outranked"]);
  });

  test("3. the same spare is rejected on cwd alone, with no kind field", async () => {
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        9948: {
          json: {
            sessionId: "9fd24c8e",
            status: "idle",
            cwd: WT,
            kind: "interactive",
            tmux: stamp("%3429"),
          },
          mtimeMs: Date.parse("2026-08-18T13:05:00Z"),
        },
        27571: {
          json: {
            sessionId: "2bf76e71",
            status: "idle",
            cwd: OTHER_WT,
          },
          mtimeMs: Date.parse("2026-08-19T03:17:00Z"),
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(
      paneOf(9948, "%3429", WT),
      chain(9948, 27243, 27538, 27571),
      deps,
    );
    expect(state.sessionId).toBe("9fd24c8e");
    expect(kinds(anomalies)).toEqual(["foreign-session-outranked"]);
  });

  test("4. legacy pane with no stamp anywhere resolves through locality", async () => {
    // CLI 2.1.139 / 2.1.181 write no `tmux` field at all. Tier 2 is the only
    // thing standing between those panes and a permanently blank session id.
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        31093: {
          json: {
            sessionId: "ced106a4",
            status: "idle",
            cwd: WT,
            kind: "interactive",
          },
          mtimeMs: NOW - 58 * DAY_MS,
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(
      paneOf(31093, "%424"),
      chain(31093),
      deps,
    );
    expect(state.sessionId).toBe("ced106a4");
    expect(anomalies).toEqual([]);
  });

  test("5. legacy relocation (the July 2026 incident) still follows the leaf", async () => {
    // launcher → daemon run → --bg-pty-host → the real agent, on a CLI that
    // stamps nothing. A daemon-hosted process does not inherit $TMUX_PANE, so
    // it CANNOT stamp itself — a stamp-only rule would pin this pane to the
    // launcher's tombstone and freeze the transcript, which is exactly what
    // cost 747 minutes in July 2026 and 10h25m on 2026-08-18.
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        99082: {
          json: { sessionId: "4a4671db", status: "idle", cwd: WT },
          mtimeMs: NOW - 12 * 60 * 60 * 1000,
        },
        5414: {
          json: { sessionId: "af01a393", status: "busy", cwd: WT },
          mtimeMs: NOW - 60 * 1000,
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(
      paneOf(99082),
      chain(99082, 5302, 5330, 5414),
      deps,
    );
    expect(state).toEqual({
      sessionId: "af01a393",
      status: "busy",
      waitingFor: null,
      statusUpdatedAt: null,
    });
    expect(anomalies).toEqual([]);
  });

  test("6. a forked launcher with no file of its own resolves to the stamped child", async () => {
    const deps = depsOf({
      2: {
        json: {
          sessionId: "child",
          status: "busy",
          tmux: stamp("%1"),
          cwd: WT,
        },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("child");
  });

  test("7. the same forked launcher resolves through cwd when nothing stamps", async () => {
    const deps = depsOf({
      2: {
        json: { sessionId: "child", status: "busy", cwd: WT },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("child");
  });

  test("8. a subtree that only names another pane's session is loudly empty", async () => {
    // The point of the anomaly: "nothing claimed this pane" used to be
    // indistinguishable from "Claude has not written its file yet".
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        2: {
          json: { sessionId: "theirs", tmux: stamp("%9"), cwd: OTHER_WT },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(paneOf(1), chain(1, 2), deps);
    expect(state).toEqual({
      sessionId: null,
      status: null,
      waitingFor: null,
      statusUpdatedAt: null,
    });
    expect(kinds(anomalies)).toEqual(["unclaimed-subtree-session"]);
  });

  test("9. an unparseable tmux stamp is a hard error naming the stamp", async () => {
    // Silence here would demote the whole fleet to tier 2 at once.
    const deps = depsOf({
      1: { json: { sessionId: "abc", tmux: "pane-7", cwd: WT }, mtimeMs: NOW },
    });
    const err = await rejection(resolveSessionState(paneOf(1), chain(1), deps));
    expect(err.message).toMatch(/Unrecognised tmux stamp "pane-7"/);
  });

  test("10. a fresher rejected record is reported, and the winner still returns", async () => {
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: { sessionId: "mine", status: "idle", cwd: WT },
          mtimeMs: NOW - DAY_MS,
        },
        2: {
          json: {
            sessionId: "theirs",
            status: "busy",
            cwd: OTHER_WT,
            kind: "bg",
          },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("mine");
    expect(kinds(anomalies)).toEqual(["foreign-session-outranked"]);
    expect(anomalies[0]!.detail.foreignSessionId).toBe("theirs");
  });

  test("11. an unrecognised status in a foreign record does not throw for this pane", async () => {
    // Live latent bug before the identity/status split: one bg-spare running a
    // newer CLI threw and blanked whichever pane happened to host the daemon.
    const deps = depsOf({
      1: {
        json: { sessionId: "mine", status: "idle", tmux: stamp("%1"), cwd: WT },
        mtimeMs: NOW,
      },
      2: {
        json: {
          sessionId: "theirs",
          status: "compacting",
          cwd: OTHER_WT,
          kind: "bg",
        },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("mine");
  });

  test("12. a bg record in this very worktree still loses to a stamped claimant", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "mine", status: "idle", tmux: stamp("%1"), cwd: WT },
        mtimeMs: NOW - DAY_MS,
      },
      2: {
        json: { sessionId: "spare", status: "busy", cwd: WT, kind: "bg" },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("mine");
  });

  test("an unrecognised kind is reported, not thrown, and stays eligible", async () => {
    // `kind` only ever excludes, so a value a newer CLI introduces must not be
    // able to blank a pane — it is reported and treated as "not a bg host".
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: { sessionId: "mine", status: "idle", cwd: WT, kind: "sandbox" },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    expect(
      (await resolveSessionState(paneOf(1), chain(1), deps)).sessionId,
    ).toBe("mine");
    expect(kinds(anomalies)).toEqual(["unknown-session-kind"]);
  });

  test("19. a nested `claude --print` the agent ran inherits the stamp but never wins", async () => {
    // 2026-10-11, pane %841: the agent ran `cd /tmp && claude --print …` from
    // its Bash tool. The child inherited $TMUX_PANE, stamped this pane, and
    // wrote its file after the pane's idle one — freshest-in-tier adopted it.
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: {
            sessionId: "pane",
            status: "busy",
            tmux: stamp("%1"),
            cwd: WT,
            kind: "interactive",
          },
          mtimeMs: NOW - 60_000,
        },
        3: {
          json: {
            sessionId: "nested-print",
            status: "busy",
            tmux: stamp("%1"),
            cwd: "/private/tmp",
            kind: "interactive",
          },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    // 1 = the pane's claude, 2 = its Bash tool's shell, 3 = the nested claude.
    const state = await resolveSessionState(paneOf(1), chain(1, 2, 3), deps);
    expect(state.sessionId).toBe("pane");
    expect(kinds(anomalies)).toEqual([]);
  });

  test("identical mtimes resolve to the deepest pid", async () => {
    const deps = depsOf({
      1: { json: { sessionId: "launcher", cwd: WT }, mtimeMs: NOW },
      2: { json: { sessionId: "daemon", cwd: WT }, mtimeMs: NOW },
    });
    expect(
      (await resolveSessionState(paneOf(1), chain(1, 2), deps)).sessionId,
    ).toBe("daemon");
  });

  test("pids outside the pane's subtree are never considered", async () => {
    const tree: ProcessTree = {
      children: new Map([[1, [2]]]),
      pids: new Set([1, 2, 777]),
    };
    const deps = depsOf({
      2: {
        json: { sessionId: "mine", status: "idle", cwd: WT },
        mtimeMs: NOW - DAY_MS,
      },
      777: {
        json: { sessionId: "someone-elses", status: "busy", cwd: WT },
        mtimeMs: NOW,
      },
    });
    expect((await resolveSessionState(paneOf(1), tree, deps)).sessionId).toBe(
      "mine",
    );
  });

  test("a file without a sessionId is not a candidate, and is not evidence", async () => {
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      { 1: { json: { status: "idle" }, mtimeMs: NOW } },
      anomalies,
    );
    const state = await resolveSessionState(paneOf(1), chain(1), deps);
    expect(state).toEqual({
      sessionId: null,
      status: null,
      waitingFor: null,
      statusUpdatedAt: null,
    });
    expect(anomalies).toEqual([]);
  });

  test("18. no session file anywhere in the subtree yields a silent null state", async () => {
    // Legitimate: Claude has not written ~/.claude/sessions/<pid>.json yet.
    const anomalies: AnomalyLog = [];
    const state = await resolveSessionState(
      paneOf(1),
      chain(1, 2, 3),
      depsOf({}, anomalies),
    );
    expect(state).toEqual({
      sessionId: null,
      status: null,
      waitingFor: null,
      statusUpdatedAt: null,
    });
    expect(anomalies).toEqual([]);
  });

  test("an unknown CLI status on the adopted record is a hard error", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "abc", status: "compacting", cwd: WT },
        mtimeMs: NOW,
      },
    });
    const err = await rejection(resolveSessionState(paneOf(1), chain(1), deps));
    expect(err.message).toMatch(
      /Unknown Claude CLI session status "compacting"/,
    );
  });

  test("a non-ENOENT read failure propagates", async () => {
    const deps: SessionFileDeps = {
      readSessionFile: () => Promise.reject(new Error("EACCES")),
      statSessionFile: () => Promise.resolve(NOW),
      listSessionPids: () => Promise.resolve([]),
      reportAnomaly: () => {},
    };
    const err = await rejection(resolveSessionState(paneOf(1), chain(1), deps));
    expect(err.message).toContain("EACCES");
  });

  test("a failing process lister propagates instead of resolving against an empty tree", async () => {
    const err = await rejection(
      captureProcessTree(() => Promise.reject(new Error("ps failed"))).then(
        (tree) => resolveSessionState(paneOf(1), tree, depsOf({})),
      ),
    );
    expect(err.message).toContain("ps failed");
  });
});

describe("resolveSessionState — parked background jobs", () => {
  // Claude Code can park a pane's session as a background job: it forks the
  // conversation to a new session id, hands it to a --bg-pty-host process that
  // launchd re-parents, and leaves a stub in the pane. The stub's file stops
  // being written and still names the PRE-fork id, so subtree + mtime alone
  // pin the conversation to a transcript that never grows again — the real
  // 2026-08-18 incident (10h of turns written where the UI could not read them).
  test("the pane follows its parked pointer to the job actually running", async () => {
    const deps = depsOf({
      9948: {
        json: {
          sessionId: "9fd24c8e",
          status: "idle",
          cwd: WT,
          tmux: stamp("%1"),
          parkedJobId: "baf9c302",
        },
        mtimeMs: NOW - 10 * 60 * 60 * 1000,
      },
      // Outside the pane's subtree entirely: its host is re-parented to launchd.
      11536: {
        json: {
          sessionId: "baf9c302-68bf",
          status: "busy",
          cwd: WT,
          kind: "bg",
          jobId: "baf9c302",
        },
        mtimeMs: NOW - 60 * 1000,
      },
    });
    const state = await resolveSessionState(
      paneOf(9948),
      alsoLive(chain(9948), 11536),
      deps,
    );
    expect(state).toEqual({
      sessionId: "baf9c302-68bf",
      status: "busy",
      waitingFor: null,
      statusUpdatedAt: null,
    });
  });

  test("the pointer wins even when the stub's own file is the fresher one", async () => {
    // The stub is stale BY CONSTRUCTION — it stopped writing when it parked —
    // so freshness must not get a vote here, or a stub touched by anything
    // (a status flap, a resize) would take the pane back to the dead id.
    const deps = depsOf({
      1: {
        json: {
          sessionId: "stub",
          status: "idle",
          cwd: WT,
          parkedJobId: "job-1",
        },
        mtimeMs: NOW,
      },
      2: {
        json: {
          sessionId: "live",
          status: "busy",
          cwd: WT,
          kind: "bg",
          jobId: "job-1",
        },
        mtimeMs: NOW - 5 * 60 * 1000,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), alsoLive(chain(1), 2), deps))
        .sessionId,
    ).toBe("live");
  });

  test("a parked job that has exited leaves the pane on its own id", async () => {
    // Nothing claims the job, so the stub's id is the best we have — which is
    // exactly the pre-park behaviour, not a new failure.
    const deps = depsOf({
      1: {
        json: {
          sessionId: "stub",
          status: "idle",
          cwd: WT,
          parkedJobId: "job-gone",
        },
        mtimeMs: NOW,
      },
    });
    const state = await resolveSessionState(paneOf(1), chain(1), deps);
    expect(state).toEqual({
      sessionId: "stub",
      status: "idle",
      waitingFor: null,
      statusUpdatedAt: null,
    });
  });

  test("a job that parked again is followed to the end of the chain", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "stub", cwd: WT, parkedJobId: "job-1" },
        mtimeMs: NOW,
      },
      2: {
        json: {
          sessionId: "middle",
          cwd: WT,
          kind: "bg",
          jobId: "job-1",
          parkedJobId: "job-2",
        },
        mtimeMs: NOW,
      },
      3: {
        json: {
          sessionId: "last",
          status: "busy",
          cwd: WT,
          kind: "bg",
          jobId: "job-2",
        },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), alsoLive(chain(1), 2, 3), deps))
        .sessionId,
    ).toBe("last");
  });

  test("a pointer cycle terminates instead of spinning", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "stub", cwd: WT, parkedJobId: "job-a" },
        mtimeMs: NOW,
      },
      2: {
        json: {
          sessionId: "a",
          cwd: WT,
          kind: "bg",
          jobId: "job-a",
          parkedJobId: "job-b",
        },
        mtimeMs: NOW,
      },
      3: {
        json: {
          sessionId: "b",
          cwd: WT,
          kind: "bg",
          jobId: "job-b",
          parkedJobId: "job-a",
        },
        mtimeMs: NOW,
      },
    });
    expect(
      (await resolveSessionState(paneOf(1), alsoLive(chain(1), 2, 3), deps))
        .sessionId,
    ).toBe("b");
  });

  test("a host claiming the job but naming no session is not adopted", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "stub", cwd: WT, parkedJobId: "job-1" },
        mtimeMs: NOW,
      },
      2: { json: { jobId: "job-1", status: "busy" }, mtimeMs: NOW },
    });
    expect(
      (await resolveSessionState(paneOf(1), alsoLive(chain(1), 2), deps))
        .sessionId,
    ).toBe("stub");
  });

  test("13. two live processes claiming one job id is a hard error naming both", async () => {
    const deps = depsOf({
      1: {
        json: { sessionId: "stub", cwd: WT, parkedJobId: "job-1" },
        mtimeMs: NOW,
      },
      2: {
        json: { sessionId: "a", cwd: WT, kind: "bg", jobId: "job-1" },
        mtimeMs: NOW,
      },
      3: {
        json: { sessionId: "b", cwd: WT, kind: "bg", jobId: "job-1" },
        mtimeMs: NOW,
      },
    });
    const err = await rejection(
      resolveSessionState(paneOf(1), alsoLive(chain(1), 2, 3), deps),
    );
    expect(err.message).toMatch(/Job job-1 is claimed by 2 live processes/);
    expect(err.message).toContain("2, 3");
  });

  test("14. a leaked file from an exited host is skipped, not a contradiction", async () => {
    // Without the liveness filter this pane would throw on every reconcile forever.
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: { sessionId: "stub", cwd: WT, parkedJobId: "job-1" },
          mtimeMs: NOW,
        },
        2: {
          json: { sessionId: "dead", cwd: WT, kind: "bg", jobId: "job-1" },
          mtimeMs: NOW - DAY_MS,
        },
        3: {
          json: {
            sessionId: "live",
            status: "busy",
            cwd: WT,
            kind: "bg",
            jobId: "job-1",
          },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    // pid 2 is deliberately absent from the snapshot: it has exited.
    const state = await resolveSessionState(
      paneOf(1),
      alsoLive(chain(1), 3),
      deps,
    );
    expect(state.sessionId).toBe("live");
    expect(kinds(anomalies)).toEqual(["stale-job-host-file"]);
    expect(anomalies[0]!.detail.pid).toBe(2);
  });

  test("15. a park hop into another directory is followed, and reported", async () => {
    const anomalies: AnomalyLog = [];
    const deps = depsOf(
      {
        1: {
          json: {
            sessionId: "stub",
            cwd: WT,
            tmux: stamp("%1"),
            parkedJobId: "job-1",
          },
          mtimeMs: NOW,
        },
        2: {
          json: {
            sessionId: "live",
            status: "busy",
            cwd: OTHER_WT,
            kind: "bg",
            jobId: "job-1",
          },
          mtimeMs: NOW,
        },
      },
      anomalies,
    );
    const state = await resolveSessionState(
      paneOf(1),
      alsoLive(chain(1), 2),
      deps,
    );
    expect(state.sessionId).toBe("live");
    expect(kinds(anomalies)).toEqual(["cwd-mismatch"]);
  });

  test("17. an unparked pane never lists the sessions directory", async () => {
    // The scan is the cost this pointer hop adds; it must stay off the path of
    // the panes that never park (22 of 23 in the wild).
    let listed = 0;
    const base = depsOf({
      1: { json: { sessionId: "solo", cwd: WT }, mtimeMs: NOW },
    });
    const deps: SessionFileDeps = {
      ...base,
      listSessionPids: () => {
        listed++;
        return base.listSessionPids();
      },
    };
    await resolveSessionState(paneOf(1), chain(1), deps);
    expect(listed).toBe(0);
  });
});

describe("parseTmuxStamp", () => {
  test("splits session, window and pane", () => {
    expect(
      parseTmuxStamp("conv-1787129489-vnbm:@3466.%3466", "f.json"),
    ).toEqual({
      sessionName: "conv-1787129489-vnbm",
      windowId: "@3466",
      paneId: "%3466",
    });
  });

  test("a session name containing ':' keeps everything before the last window", () => {
    expect(parseTmuxStamp("a:b:@1.%2", "f.json").sessionName).toBe("a:b");
  });

  test("throws on format drift, naming the file", () => {
    expect(() => parseTmuxStamp("pane-7", "/s/42.json")).toThrow(
      /Unrecognised tmux stamp "pane-7" in \/s\/42.json/,
    );
  });
});

describe("routeSessionFile", () => {
  test("a stamped record routes to its tmux session", () => {
    expect(
      routeSessionFile(
        JSON.stringify({ tmux: "conv-1-a:@1.%1", cwd: "/wt" }),
        "f.json",
      ),
    ).toEqual({ kind: "session", sessionName: "conv-1-a" });
  });

  test("an unstamped record routes to its cwd", () => {
    expect(routeSessionFile(JSON.stringify({ cwd: "/wt" }), "f.json")).toEqual({
      kind: "cwd",
      cwd: "/wt",
    });
  });

  test("a record naming neither routes nowhere", () => {
    expect(routeSessionFile("{}", "f.json")).toEqual({ kind: "none" });
  });
});
