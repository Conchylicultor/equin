/**
 * The `steps` machinery, driven with an in-memory step log, real marker files
 * and real processes — the same trade `loop.test.ts` makes: the memo and the
 * wait are contracts, the marker and the pid are not faked.
 */
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { HARD_KILL_EXIT_CODE, type RunTerminal } from "../../core";
import type { LogChannel } from "@plugins/primitives/plugins/log-channels/server";
import type { LoopCtx } from "./loop";
import { defineSupervisedRunKind, type UnfinishedRun } from "./run/registry";
import { SupervisedSpawnError } from "./run/supervisor";
import {
  runStepsBody,
  type RunStep,
  type StepOutcome,
  type StepRunnerOpts,
  type SupervisedJobSpawn,
} from "./steps";

const worktree = runtimeNamespace();
const KIND_ID = "supjobsteps";
const channel = { publishAll: () => {} } as unknown as LogChannel;

const kind = defineSupervisedRunKind({
  id: KIND_ID,
  channel,
  listUnfinished: () => Promise.resolve([]),
  setPid: () => Promise.resolve(),
  finish: () => Promise.resolve(),
});
await kind.register();

const created: string[] = [];

function uniqueRunId(tag: string): string {
  return `s-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeMarker(runId: string, body: string): void {
  mkdirSync(worktreeArtifacts.runsDir(worktree), { recursive: true });
  const path = worktreeArtifacts.runTerminal(worktree, KIND_ID, runId);
  created.push(path);
  writeFileSync(path, body);
}

afterEach(() => {
  for (const path of created.splice(0)) if (existsSync(path)) rmSync(path);
});

/** One workflow's step log, shared across passes the way a resume shares it. */
function createCtx(onWait?: () => void): {
  ctx: Pick<LoopCtx, "step" | "waitFor">;
  steps: string[];
  waits: string[];
} {
  const recorded = new Map<string, unknown>();
  const steps: string[] = [];
  const waits: string[] = [];
  return {
    steps,
    waits,
    ctx: {
      async step<R>(name: string, fn: () => Promise<R> | R): Promise<R> {
        steps.push(name);
        if (recorded.has(name)) return recorded.get(name) as R;
        const result = await fn();
        recorded.set(name, result);
        return result;
      },
      waitFor: <T extends Record<string, unknown>>(
        _event: unknown,
        opts?: { name?: string },
      ): Promise<T | null> => {
        waits.push(opts?.name ?? "");
        onWait?.();
        return Promise.resolve(null);
      },
    } as Pick<LoopCtx, "step" | "waitFor">,
  };
}

const noClose = (): Promise<void> => Promise.resolve();
const noUnfinished = (): Promise<readonly UnfinishedRun[]> =>
  Promise.resolve([]);

/** A suspend signal as the jobs plugin brands it (the class is not exported). */
function suspendSignal(): Error {
  const err = new Error("suspended");
  (err as unknown as Record<symbol, unknown>)[
    Symbol.for("@plugins/jobs:SuspendSignal")
  ] = true;
  return err;
}

/** Run `body` as one dispatch's `steps` body. */
function dispatch(
  opts: Omit<StepRunnerOpts, "listUnfinished"> & {
    listUnfinished?: StepRunnerOpts["listUnfinished"];
  },
  body: (step: RunStep) => Promise<void>,
): Promise<void> {
  return runStepsBody({
    listUnfinished: noUnfinished,
    ...opts,
    body,
  });
}

describe("runStepsBody", () => {
  test("spawns child <runId>.<name> once, waits on it, and returns its terminal", async () => {
    const runId = uniqueRunId("basic");
    const spawned: { childId: string; spawn: SupervisedJobSpawn }[] = [];
    const began: string[] = [];
    const { ctx, steps, waits } = createCtx(() =>
      writeMarker(`${runId}.converge`, "0 -\n"),
    );
    const seen: { outcome?: StepOutcome } = {};
    await dispatch(
      {
        ctx,
        kind,
        runId,
        beginStep: (id, name) => {
          began.push(`${id}/${name}`);
          return Promise.resolve(true);
        },
        closeRow: noClose,
        start: (childId, spawn) => {
          spawned.push({ childId, spawn });
          return Promise.resolve({ pid: process.pid });
        },
      },
      async (step) => {
        seen.outcome = await step("converge", { argv: ["true"] });
      },
    );

    expect(began).toEqual([`${runId}/converge`]);
    expect(spawned).toEqual([
      { childId: `${runId}.converge`, spawn: { argv: ["true"] } },
    ]);
    // The exact durable names, asserted as literals: they are the names deploy's
    // hand-written sequence recorded before it moved onto `steps`, so a deploy
    // suspended across that release re-attaches instead of spawning twice.
    expect(steps).toEqual(["spawn:converge"]);
    expect(waits).toEqual(["converge:0"]);
    expect(seen.outcome).toEqual(
      expect.objectContaining({ state: "ended", runId: `${runId}.converge` }),
    );
  });

  test("a replay after a resume re-attaches instead of spawning twice", async () => {
    const runId = uniqueRunId("replay");
    let suspended = false;
    // First pass: the wait suspends (a throw that leaves the handler).
    const { ctx, steps } = createCtx(() => {
      if (!suspended) {
        suspended = true;
        throw suspendSignal();
      }
    });
    let spawns = 0;
    let beginSteps = 0;
    let closes = 0;
    const out: RunTerminal[] = [];
    const run = (): Promise<void> =>
      dispatch(
        {
          ctx,
          kind,
          runId,
          beginStep: () => {
            beginSteps += 1;
            return Promise.resolve(true);
          },
          closeRow: () => {
            closes += 1;
            return Promise.resolve();
          },
          start: () => {
            spawns += 1;
            return Promise.resolve({ pid: process.pid });
          },
        },
        async (step) => {
          out.length = 0;
          for (const name of ["one", "two"]) {
            const o = await step(name, { argv: ["true"] });
            if (o.state === "ended") out.push(o.terminal);
          }
        },
      );

    writeMarker(`${runId}.one`, "0 -\n");
    expect(run()).rejects.toMatchObject({ message: "suspended" });
    // The resume: step one's marker was already there, step two's lands now.
    writeMarker(`${runId}.two`, "3 -\n");
    await run();

    expect(spawns).toBe(2);
    expect(beginSteps).toBe(2);
    expect(closes).toBe(0);
    expect(steps).toEqual(["spawn:one", "spawn:two", "spawn:one", "spawn:two"]);
    expect(out.map((t) => t.exitCode)).toEqual([0, 3]);
  });

  test("a memo recorded by deploy's pre-steps sequence re-attaches without spawning", async () => {
    const runId = uniqueRunId("legacy");
    const childId = `${runId}.ship`;
    // A live child the legacy memo names, whose pid only the ledger holds.
    const child = Bun.spawn(["sleep", "30"]);
    try {
      const { ctx, waits } = createCtx(() => writeMarker(childId, "0 -\n"));
      // The step log as the legacy sequence left it: `spawn:ship` → spawned.
      await ctx.step("spawn:ship", () => ({ state: "spawned" }));
      let spawns = 0;
      let listed = 0;
      const seen: { outcome?: StepOutcome } = {};
      await dispatch(
        {
          ctx,
          kind,
          runId,
          beginStep: () => Promise.resolve(true),
          closeRow: noClose,
          listUnfinished: () => {
            listed += 1;
            return Promise.resolve([{ runId: childId, pid: child.pid }]);
          },
          start: () => {
            spawns += 1;
            return Promise.resolve({ pid: process.pid });
          },
        },
        async (step) => {
          seen.outcome = await step("ship", { argv: ["true"] });
        },
      );

      expect(spawns).toBe(0);
      expect(listed).toBe(1);
      // The child is alive, so the step waited (on the legacy wait name) rather
      // than reading a missing pid as a hard kill.
      expect(waits).toEqual(["ship:0"]);
      expect(seen.outcome).toEqual(
        expect.objectContaining({ state: "ended", runId: childId }),
      );
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("a legacy memo for a child no longer unfinished reads its marker, else the hard kill", async () => {
    const runId = uniqueRunId("legacygone");
    const { ctx, waits } = createCtx();
    await ctx.step("spawn:converge", () => ({ state: "spawned" }));
    await ctx.step("spawn:ship", () => ({ state: "spawned" }));
    writeMarker(`${runId}.converge`, "0 -\n");
    const codes: number[] = [];
    await dispatch(
      {
        ctx,
        kind,
        runId,
        closeRow: noClose,
        start: () => Promise.reject(new Error("must not spawn")),
      },
      async (step) => {
        for (const name of ["converge", "ship"]) {
          const o = await step(name, { argv: ["true"] });
          if (o.state !== "ended") throw new Error("expected ended");
          codes.push(o.terminal.exitCode);
        }
      },
    );

    expect(waits).toEqual([]);
    expect(codes).toEqual([0, HARD_KILL_EXIT_CODE]);
  });

  test("a beginStep refusal spawns nothing and answers run-closed", async () => {
    const runId = uniqueRunId("closed");
    const { ctx, waits } = createCtx();
    let spawns = 0;
    const seen: { outcome?: StepOutcome } = {};
    await dispatch(
      {
        ctx,
        kind,
        runId,
        beginStep: () => Promise.resolve(false),
        closeRow: noClose,
        start: () => {
          spawns += 1;
          return Promise.resolve({ pid: process.pid });
        },
      },
      async (step) => {
        seen.outcome = await step("ship", { argv: ["true"] });
      },
    );

    expect(seen.outcome).toEqual({ state: "run-closed" });
    expect(spawns).toBe(0);
    expect(waits).toEqual([]);
  });

  test("a spawn that started no child is answered to the body, then its row is closed AFTER the body", async () => {
    const runId = uniqueRunId("notstarted");
    const events: string[] = [];
    const { ctx, steps } = createCtx();
    const seen: { outcome?: StepOutcome } = {};
    await dispatch(
      {
        ctx,
        kind,
        runId,
        closeRow: (id, terminal) => {
          events.push(`close ${id} ${terminal.exitCode}`);
          return Promise.resolve();
        },
        start: () => Promise.reject(new SupervisedSpawnError("boom", false)),
      },
      async (step) => {
        seen.outcome = await step("converge", { argv: ["x"] });
        events.push("body recorded its verdict");
      },
    );

    expect(seen.outcome).toEqual({
      state: "not-started",
      runId: `${runId}.converge`,
      message: "boom",
    });
    // Memoized as a value, not a thrown step a replay would re-raise forever.
    expect(steps).toEqual(["spawn:converge"]);
    expect(events).toEqual([
      "body recorded its verdict",
      `close ${runId}.converge ${HARD_KILL_EXIT_CODE}`,
    ]);
  });

  test("the last-resort close also runs when the body throws, and never on a suspend", async () => {
    const runId = uniqueRunId("notstartedthrow");
    const closed: string[] = [];
    const opts = {
      kind,
      runId,
      closeRow: (id: string) => {
        closed.push(id);
        return Promise.resolve();
      },
      start: () => Promise.reject(new SupervisedSpawnError("boom", false)),
    };

    const thrown = createCtx();
    expect(
      dispatch({ ...opts, ctx: thrown.ctx }, async (step) => {
        await step("converge", { argv: ["x"] });
        throw new Error("body failed");
      }),
    ).rejects.toMatchObject({ message: "body failed" });

    expect(closed).toEqual([`${runId}.converge`]);

    closed.length = 0;
    const suspending = createCtx();
    expect(
      dispatch({ ...opts, ctx: suspending.ctx }, async (step) => {
        await step("converge", { argv: ["x"] });
        throw suspendSignal();
      }),
    ).rejects.toMatchObject({ message: "suspended" });

    expect(closed).toEqual([]);
  });

  test("a spawn that may have started a child throws and closes nothing", async () => {
    const runId = uniqueRunId("maybestarted");
    const closed: string[] = [];
    const { ctx } = createCtx();
    expect(
      dispatch(
        {
          ctx,
          kind,
          runId,
          closeRow: (id) => {
            closed.push(id);
            return Promise.resolve();
          },
          start: (childId) =>
            Promise.reject(
              new SupervisedSpawnError("boom", childId.endsWith(".after")),
            ),
        },
        async (step) => {
          await step("before", { argv: ["x"] });
          await step("after", { argv: ["x"] });
        },
      ),
    ).rejects.toMatchObject({ message: "boom" });

    // `before` never started, but `after` may be running under the same lock.
    expect(closed).toEqual([]);
  });

  test("a step name may not repeat within a run, nor leave the filename alphabet", async () => {
    const runId = uniqueRunId("names");
    writeMarker(`${runId}.once`, "0 -\n");
    const { ctx } = createCtx();
    await dispatch(
      {
        ctx,
        kind,
        runId,
        closeRow: noClose,
        start: () => Promise.resolve({ pid: process.pid }),
      },
      async (step) => {
        await step("once", { argv: ["true"] });
        expect(step("once", { argv: ["true"] })).rejects.toThrow("ran twice");
        expect(step("a/b", { argv: ["true"] })).rejects.toThrow(
          "invalid step name",
        );
      },
    );
  });
});
