/**
 * The watch policy against the REAL worktree DB, inside rolled-back
 * transactions (`worktreeDbScenario`): routing to the nearest live watch,
 * re-routing off a dead one, quiet transitions, and delivery batching N rows
 * into ONE turn — held while the watcher is busy or waiting on the user,
 * idempotent across a retry. The agent side (submit, digest) is a fake port.
 *
 * Needs this worktree's DB as `./equin build` leaves it (the task_watches /
 * watch_inbox migration applied, the derived views built).
 *
 * Run: `./equin test plugins/tasks/plugins/orchestration/plugins/watch`.
 */
import { describe, expect, test } from "bun:test";
import { sql, eq } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import type { TurnId } from "@plugins/conversations/plugins/turn-ledger/core";
import type { TurnReadiness } from "@plugins/conversations/plugins/automatic-turn/server";
import type { WatchEvent, WatchId } from "../../core";
import {
  claimDelivery,
  sendClaimedTurn,
  turnIdFor,
  type DeliverOutcome,
  type DeliverPorts,
} from "./deliver";
import {
  endWatch,
  nearestLiveWatch,
  refreshTaskManagers,
  takeOverTreeWatch,
  watchTask,
} from "./queries";
import { evaluateQuiet } from "./quiet";
import { routeEvents } from "./route";
import { _taskWatches, _watchInbox, tasksManager } from "./tables";

type Tx = DbExecutor;

let seq = 0;
const uid = (k: string) => `wt${k}-${Date.now()}-${++seq}`;

async function task(tx: Tx, folderId: string | null): Promise<string> {
  const id = uid("task");
  await tx.execute(sql`
    INSERT INTO tasks (id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref)
    VALUES (${id}, ${`T ${id}`}, true, ${id}, ${folderId}, now(), now(),
            ${folderId === null ? sql`'interactive'` : sql`NULL`})
  `);
  return id;
}

/** A conversation on `taskId` (its own attempt) in `status`. */
async function conversation(
  tx: Tx,
  taskId: string,
  status: "starting" | "working" | "waiting" | "done",
): Promise<string> {
  const attemptId = uid("att");
  const id = uid("conv");
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await tx.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by)
    VALUES (${id}, ${attemptId}, ${status}, 'sdk', ${FALLBACK_MODEL}, 'test')
  `);
  return id;
}

async function setStatus(tx: Tx, conversationId: string, status: string) {
  await tx.execute(
    sql`UPDATE conversations SET status = ${status} WHERE id = ${conversationId}`,
  );
}

async function arm(tx: Tx, taskId: string) {
  await tx.execute(sql`
    INSERT INTO tasks_ext_auto_start (parent_id, auto_start_at, auto_start_model)
    VALUES (${taskId}, now(), ${FALLBACK_MODEL})
  `);
}

async function inbox(tx: Tx, watchId: WatchId) {
  return tx.select().from(_watchInbox).where(eq(_watchInbox.watchId, watchId));
}

/** A fake agent: records every submitted turn; its readiness per
 * conversation (ready unless set). */
function fakePorts(state: Map<string, TurnReadiness> = new Map()) {
  const turns: { conversationId: string; turnId: TurnId; text: string }[] = [];
  const batches: WatchEvent[][] = [];
  const ports: DeliverPorts = {
    readiness: async (id) => state.get(id) ?? { kind: "ready" },
    submit: async (conversationId, turnId, text) => {
      turns.push({ conversationId, turnId, text });
    },
    digest: async () => "DIGEST",
    turnRecorded: async (turnId) => turns.some((t) => t.turnId === turnId),
    handler: (id) =>
      id === "test.handler"
        ? {
            id,
            onEvents: async (batch) => {
              batches.push(batch);
            },
          }
        : undefined,
  };
  return { ports, turns, batches, state };
}

/** The job's two steps on the scenario's one transaction: claim, then send
 * a conversation turn. */
async function deliver(
  tx: Tx,
  watchId: WatchId,
  ports: DeliverPorts,
): Promise<DeliverOutcome> {
  const out = await claimDelivery(tx, watchId, ports);
  return out.kind === "claimed" ? sendClaimedTurn(tx, out, ports) : out;
}

describe("routing", () => {
  test("goes to the nearest live watch, skipping the actor's own, an ended one and a done watcher", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const mid = await task(tx, root);
      const leaf = await task(tx, mid);
      const rootConv = await conversation(tx, root, "waiting");
      const midConv = await conversation(tx, mid, "waiting");
      const leafConv = await conversation(tx, leaf, "working");
      const rootW = await watchTask(
        root,
        { kind: "conversation", conversationId: rootConv },
        tx,
      );
      const midW = await watchTask(
        mid,
        { kind: "conversation", conversationId: midConv },
        tx,
      );

      const nearest = (await nearestLiveWatch(tx, leaf, null))?.id;
      // The actor's own watch never hears its action.
      const notOwn = (await nearestLiveWatch(tx, leaf, midConv))?.id;
      await setStatus(tx, midConv, "done");
      const afterDone = (await nearestLiveWatch(tx, leaf, null))?.id;
      await endWatch(rootW.id, tx);
      const afterEnd = await nearestLiveWatch(tx, leaf, null);

      // Routing writes one inbox row per event, to the nearest live watch.
      await setStatus(tx, midConv, "waiting");
      const routed = await routeEvents(tx, [
        {
          kind: "reported",
          taskId: leaf,
          actorConversationId: leafConv,
          summary: "a",
        },
        { kind: "flagged", taskId: leaf, summary: "b" },
      ]);
      return {
        rootW: rootW.id,
        midW: midW.id,
        nearest,
        notOwn,
        afterDone,
        afterEnd,
        routed: [...routed],
        midInbox: (await inbox(tx, midW.id)).map((r) => r.kind).sort(),
      };
    });
    expect(got.nearest).toBe(got.midW);
    expect(got.notOwn).toBe(got.rootW);
    expect(got.afterDone).toBe(got.rootW);
    expect(got.afterEnd).toBeNull();
    expect(got.routed).toEqual([got.midW]);
    expect(got.midInbox).toEqual(["flagged", "reported"]);
  });

  test("watchTask is idempotent per (task, watcher)", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const a = await watchTask(
        root,
        { kind: "code", handler: "h", key: "k" },
        tx,
      );
      const b = await watchTask(
        root,
        { kind: "code", handler: "h", key: "k" },
        tx,
      );
      const c = await watchTask(
        root,
        { kind: "code", handler: "h", key: "other" },
        tx,
      );
      return { a: a.id, b: b.id, c: c.id };
    });
    expect(got.b).toBe(got.a);
    expect(got.c).not.toBe(got.a);
  });
});

describe("quiet", () => {
  test("one event per false → true flip; the watcher's own conversation and armed-but-blocked tasks do not count", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const child = await task(tx, root);
      const blocker = await task(tx, null);
      const watcherConv = await conversation(tx, root, "working");
      const worker = await conversation(tx, child, "working");
      const w = await watchTask(
        root,
        { kind: "conversation", conversationId: watcherConv },
        tx,
      );
      const initiallyQuiet = w.quiet;

      await setStatus(tx, worker, "waiting");
      const first = await evaluateQuiet(tx, w.id);
      const again = await evaluateQuiet(tx, w.id);

      // An armed task blocked by an unresolved prerequisite launches nothing.
      const armedBlocked = await task(tx, root);
      await arm(tx, armedBlocked);
      await tx.execute(sql`
        INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
        VALUES (${armedBlocked}, ${blocker}, now())`);
      const withBlocked = await evaluateQuiet(tx, w.id);

      // An armed task that can launch keeps the subtree active.
      const armed = await task(tx, root);
      await arm(tx, armed);
      const withArmed = await evaluateQuiet(tx, w.id);
      await tx.execute(
        sql`DELETE FROM tasks_ext_auto_start WHERE parent_id = ${armed}`,
      );
      const quietAgain = await evaluateQuiet(tx, w.id);

      return {
        initiallyQuiet,
        first,
        again,
        withBlocked,
        withArmed,
        quietAgain,
        quietEvents: (await inbox(tx, w.id)).filter((r) => r.kind === "quiet")
          .length,
      };
    });
    expect(got.initiallyQuiet).toBe(false);
    expect(got.first).toBe("became-quiet");
    expect(got.again).toBe("unchanged");
    expect(got.withBlocked).toBe("unchanged");
    expect(got.withArmed).toBe("became-busy");
    expect(got.quietAgain).toBe("became-quiet");
    expect(got.quietEvents).toBe(2);
  });
});

describe("delivery", () => {
  test("N rows become ONE turn; a retry is the same turn; nothing left after", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const child = await task(tx, root);
      const conv = await conversation(tx, root, "waiting");
      const w = await watchTask(
        root,
        { kind: "conversation", conversationId: conv },
        tx,
      );
      await routeEvents(tx, [
        { kind: "reported", taskId: child, summary: "line one\nline two" },
        { kind: "flagged", taskId: child, summary: "caveat" },
        { kind: "settled", taskId: child, summary: "done" },
      ]);
      const ids = (await inbox(tx, w.id)).map((r) => r.id);
      const out = await deliver(tx, w.id, fake.ports);
      const second = await deliver(tx, w.id, fake.ports);
      return { ids, out, second, conv };
    });
    expect(got.out).toEqual({
      kind: "delivered",
      turnId: turnIdFor(got.ids),
      count: 3,
    });
    expect(got.second).toEqual({ kind: "empty" });
    expect(fake.turns).toHaveLength(1);
    const [turn] = fake.turns;
    expect(turn?.conversationId).toBe(got.conv);
    expect(turn?.text).toContain("3 events in the tasks you watch:");
    expect(turn?.text).toContain("    line two");
    expect(turn?.text.endsWith("\n\nDIGEST")).toBe(true);
    // The id is a digest of the row SET, whatever their order.
    expect(turnIdFor([...got.ids].reverse())).toBe(turnIdFor(got.ids));
  });

  test("a conversation turn is only claimed on the transaction; sending is the second step", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const conv = await conversation(tx, root, "waiting");
      const w = await watchTask(
        root,
        { kind: "conversation", conversationId: conv },
        tx,
      );
      await routeEvents(tx, [{ kind: "flagged", taskId: root, summary: "x" }]);
      const claim = await claimDelivery(tx, w.id, fake.ports);
      return { claim: claim.kind, sentOnClaim: fake.turns.length };
    });
    expect(got.claim).toBe("claimed");
    expect(got.sentOnClaim).toBe(0);
  });

  test("a failed send gives the rows back; a claim never sent is re-claimed", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const conv = await conversation(tx, root, "waiting");
      const w = await watchTask(
        root,
        { kind: "conversation", conversationId: conv },
        tx,
      );
      await routeEvents(tx, [{ kind: "flagged", taskId: root, summary: "x" }]);
      const failing: DeliverPorts = {
        ...fake.ports,
        submit: async () => {
          throw new Error("agent gone");
        },
      };
      let error: string | null = null;
      try {
        await deliver(tx, w.id, failing);
      } catch (err) {
        error = (err as Error).message;
      }
      const afterFailure = (await inbox(tx, w.id)).filter(
        (r) => r.deliveredInTurn === null,
      ).length;
      // The backend dies between the claim and the send.
      await claimDelivery(tx, w.id, fake.ports);
      const lost = (await inbox(tx, w.id)).filter(
        (r) => r.deliveredInTurn === null,
      ).length;
      const recovered = await deliver(tx, w.id, fake.ports);
      const again = await deliver(tx, w.id, fake.ports);
      return { error, afterFailure, lost, recovered, again };
    });
    expect(got.error).toBe("agent gone");
    expect(got.afterFailure).toBe(1);
    expect(got.lost).toBe(0);
    expect(got.recovered.kind).toBe("delivered");
    expect(got.again).toEqual({ kind: "empty" });
    expect(fake.turns).toHaveLength(1);
  });

  test("held while the watcher cannot take an automatic turn, claiming nothing", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const conv = await conversation(tx, root, "working");
      const w = await watchTask(
        root,
        { kind: "conversation", conversationId: conv },
        tx,
      );
      await routeEvents(tx, [{ kind: "flagged", taskId: root, summary: "x" }]);
      fake.state.set(conv, { kind: "held", reason: "busy" });
      const busy = await deliver(tx, w.id, fake.ports);
      fake.state.set(conv, { kind: "held", reason: "waiting-for" });
      const asking = await deliver(tx, w.id, fake.ports);
      // Another plugin's turn (a compaction) goes first: typed after an
      // event turn it would reach a busy CLI.
      fake.state.set(conv, {
        kind: "held",
        reason: "pending-turn",
        by: "other",
      });
      const pending = await deliver(tx, w.id, fake.ports);
      const unclaimed = (await inbox(tx, w.id)).filter(
        (r) => r.deliveredInTurn === null,
      ).length;
      fake.state.set(conv, { kind: "ready" });
      const idle = await deliver(tx, w.id, fake.ports);
      return { busy, asking, pending, unclaimed, idle };
    });
    expect(got.busy).toEqual({ kind: "held", reason: "busy" });
    expect(got.asking).toEqual({ kind: "held", reason: "waiting-for" });
    expect(got.pending).toEqual({
      kind: "held",
      reason: "pending-turn",
      by: "other",
    });
    expect(got.unclaimed).toBe(1);
    expect(got.idle.kind).toBe("delivered");
    expect(fake.turns).toHaveLength(1);
  });

  test("a dead watcher's rows move to the next live watch above", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const mid = await task(tx, root);
      const rootConv = await conversation(tx, root, "waiting");
      const midConv = await conversation(tx, mid, "waiting");
      const rootW = await watchTask(
        root,
        { kind: "conversation", conversationId: rootConv },
        tx,
      );
      const midW = await watchTask(
        mid,
        { kind: "conversation", conversationId: midConv },
        tx,
      );
      await routeEvents(tx, [{ kind: "reported", taskId: mid, summary: "r" }]);
      await setStatus(tx, midConv, "done");
      const out = await deliver(tx, midW.id, fake.ports);
      return {
        out,
        rootW: rootW.id,
        rootInbox: (await inbox(tx, rootW.id)).length,
        midInbox: (await inbox(tx, midW.id)).length,
      };
    });
    expect(got.out).toEqual({ kind: "rerouted", to: [got.rootW], dropped: 0 });
    expect(got.rootInbox).toBe(1);
    expect(got.midInbox).toBe(0);
    expect(fake.turns).toHaveLength(0);
  });

  test("a code watcher gets the batch; an unknown handler throws", async () => {
    const fake = fakePorts();
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const w = await watchTask(
        root,
        { kind: "code", handler: "test.handler", key: "k" },
        tx,
      );
      await routeEvents(tx, [
        { kind: "reported", taskId: root, summary: "a" },
        { kind: "asking", taskId: root, summary: "b" },
      ]);
      const out = await deliver(tx, w.id, fake.ports);
      const orphan = await watchTask(
        root,
        { kind: "code", handler: "nobody", key: "k" },
        tx,
      );
      await tx
        .update(_taskWatches)
        .set({ createdAt: new Date(0) })
        .where(eq(_taskWatches.id, orphan.id));
      await routeEvents(tx, [{ kind: "flagged", taskId: root, summary: "c" }]);
      let error: string | null = null;
      try {
        await deliver(tx, orphan.id, fake.ports);
      } catch (err) {
        error = (err as Error).message;
      }
      return { out, error };
    });
    expect(got.out.kind).toBe("delivered");
    // Rows routed in one transaction share their timestamp: the batch is the
    // SET, its order within one ingest is the id tiebreak.
    expect(fake.batches.map((b) => b.map((e) => e.kind).sort())).toEqual([
      ["asking", "reported"],
    ]);
    expect(got.error).toContain('no WatchHandler "nobody"');
  });
});

describe("tree watch", () => {
  test("the latest conversation on the root takes the agent watch over, leaving a code watch alone", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const root = await task(tx, null);
      const first = await conversation(tx, root, "waiting");
      const second = await conversation(tx, root, "starting");
      const code = await watchTask(
        root,
        { kind: "code", handler: "test.handler", key: "k" },
        tx,
      );
      await takeOverTreeWatch(root, first, tx);
      await takeOverTreeWatch(root, first, tx);
      const afterFirst = await tx
        .select()
        .from(_taskWatches)
        .where(eq(_taskWatches.taskId, root));
      await takeOverTreeWatch(root, second, tx);
      const afterSecond = await tx
        .select()
        .from(_taskWatches)
        .where(eq(_taskWatches.taskId, root));
      return { code: code.id, afterFirst, afterSecond };
    });
    const agentWatches = (rows: typeof got.afterFirst) =>
      rows.filter((r) => r.id !== got.code);
    // Idempotent: one agent watch, held by the first conversation.
    expect(
      agentWatches(got.afterFirst).map((r) => r.watcherConversationId),
    ).toEqual([expect.any(String)]);
    // Handed over (same watch, new owner), not a second watch.
    const [before] = agentWatches(got.afterFirst);
    const [after] = agentWatches(got.afterSecond);
    expect(agentWatches(got.afterSecond)).toHaveLength(1);
    expect(after!.id).toBe(before!.id);
    expect(after!.watcherConversationId).not.toBe(
      before!.watcherConversationId,
    );
    expect(got.afterSecond.some((r) => r.id === got.code)).toBe(true);
  });
});

describe("task managers", () => {
  test("a task another task's live agent watches is managed by that task; its own agent, a code watcher, an ended watch and a done watcher manage nothing", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const manager = async (taskId: string) =>
        (await tasksManager.get(taskId, tx))?.managerTaskId ?? null;
      const root = await task(tx, null);
      const child = await task(tx, root);
      const rootConv = await conversation(tx, root, "waiting");
      const childConv = await conversation(tx, child, "working");

      // The root's own agent watching its tree, the child's own agent and a
      // code watcher on the child: nobody else's agent.
      await takeOverTreeWatch(root, rootConv, tx);
      await watchTask(
        child,
        { kind: "conversation", conversationId: childConv },
        tx,
      );
      await watchTask(child, { kind: "code", handler: "h", key: "k" }, tx);
      const unmanaged = [await manager(root), await manager(child)];

      // The root's agent watches what it filed.
      const w = await watchTask(
        child,
        { kind: "conversation", conversationId: rootConv },
        tx,
      );
      const managed = await manager(child);

      // Its conversation ending, then coming back (the status job's refresh).
      await setStatus(tx, rootConv, "done");
      await refreshTaskManagers(tx, [child]);
      const watcherDone = await manager(child);
      await setStatus(tx, rootConv, "waiting");
      await refreshTaskManagers(tx, [child]);
      const watcherBack = await manager(child);

      await endWatch(w.id, tx);
      const ended = await manager(child);
      return { root, unmanaged, managed, watcherDone, watcherBack, ended };
    });
    expect(got.unmanaged).toEqual([null, null]);
    expect(got.managed).toBe(got.root);
    expect(got.watcherDone).toBeNull();
    expect(got.watcherBack).toBe(got.root);
    expect(got.ended).toBeNull();
  });
});
