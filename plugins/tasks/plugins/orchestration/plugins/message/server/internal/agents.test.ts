/**
 * The tree's agents against the REAL worktree DB, inside rolled-back
 * transactions (`worktreeDbScenario`): every task under the root with its
 * latest conversation, the caller's own marked; one agent by task or
 * conversation id, anywhere; and the send policy over that read with a fake
 * agent (resume only a stopped one — a closed one only when reopened, and
 * only when the sender may — refuse an unknown id, oneself, or a task no agent
 * ran on).
 *
 * Run: `./equin test plugins/tasks/plugins/orchestration/plugins/message`.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  worktreeDbScenario,
  type DbExecutor,
} from "@plugins/database/plugins/db-test-fixture/plugins/worktree-db/server/testing";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  agentOf,
  agentsUnder,
  isUnder,
  renderAgents,
  SETTLED_SHOWN,
  type TreeAgent,
} from "./agents";
import { sendAgentMessage, type MessagePorts } from "./send";

let seq = 0;
const uid = (k: string) => `msg${k}-${Date.now()}-${++seq}`;

async function task(
  tx: DbExecutor,
  title: string,
  folderId: string | null,
): Promise<string> {
  const id = uid("task");
  await tx.execute(sql`
    INSERT INTO tasks (id, cluster_id, title, title_auto, rank, folder_id, created_at, updated_at, mandate_ref)
    VALUES (${id}, ${id}, ${title}, false, ${id}, ${folderId}, now(), now(),
            ${folderId === null ? sql`'interactive'` : sql`NULL`})
  `);
  return id;
}

async function conversation(
  tx: DbExecutor,
  taskId: string,
  status: string,
  createdAt: string,
): Promise<string> {
  const attemptId = uid("att");
  const id = uid("conv");
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, worktree_path)
    VALUES (${attemptId}, ${taskId}, ${`/tmp/${attemptId}`})
  `);
  await tx.execute(sql`
    INSERT INTO conversations (id, attempt_id, status, runtime, model, spawned_by, created_at)
    VALUES (${id}, ${attemptId}, ${status}, 'sdk', ${FALLBACK_MODEL}, 'test', ${createdAt}::timestamptz)
  `);
  return id;
}

/** root (supervisor) ⊃ a (two conversations: the later one is its agent),
 * b (stopped) ⊃ c (no agent yet). */
type Tree = Awaited<ReturnType<typeof tree>>;

async function tree(tx: DbExecutor) {
  const root = await task(tx, "Root", null);
  const a = await task(tx, "A", root);
  const b = await task(tx, "B", root);
  const c = await task(tx, "C", b);
  const sup = await conversation(tx, root, "working", "2026-01-01T00:00:00Z");
  const aOld = await conversation(tx, a, "done", "2026-01-01T00:01:00Z");
  const aNew = await conversation(tx, a, "working", "2026-01-01T00:02:00Z");
  const bConv = await conversation(tx, b, "gone", "2026-01-01T00:03:00Z");
  return { root, a, b, c, sup, aOld, aNew, bConv };
}

function fakeAgent({ mayReopen = true }: { mayReopen?: boolean } = {}) {
  const resumed: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const blocked = new Set<string>();
  const ports: MessagePorts = {
    mayReopen: async () =>
      mayReopen ? { ok: true } : { ok: false, message: "not a supervisor" },
    resume: async (id) => {
      if (blocked.has(id)) return { ok: false, message: "checkout reclaimed" };
      resumed.push(id);
      return { ok: true };
    },
    submit: async (to, text) => {
      sent.push({ to, text });
    },
  };
  return { ports, resumed, sent, blocked };
}

describe("message: tree agents", () => {
  test("every task under the root, its latest conversation, self marked", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const t = await tree(tx);
      return { t, agents: await agentsUnder(tx, t.root, t.sup) };
    });
    const { t, agents } = got;
    expect(
      agents.map((x) => [x.taskId, x.conversation?.id ?? null, x.self]),
    ).toEqual([
      [t.root, t.sup, true],
      [t.a, t.aNew, false],
      [t.b, t.bConv, false],
      [t.c, null, false],
    ]);
    const text = renderAgents(agents, { all: false });
    expect(text).toContain(`${t.aNew} · working`);
    expect(text).toContain(`${t.bConv} · stopped`);
    expect(text).toContain(`${t.sup} · working · you`);
    expect(text).toContain("1 task no agent ran on yet");
  });

  test("a worker sees the whole tree from the mandate root", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const t = await tree(tx);
      return { t, agents: await agentsUnder(tx, t.root, t.aNew) };
    });
    expect(got.agents.find((x) => x.self)?.taskId).toBe(got.t.a);
    expect(got.agents.length).toBe(4);
  });
});

describe("message: agent by ref", () => {
  test("a task id or any of its conversation ids → its latest conversation; unknown → null", async () => {
    const got = await worktreeDbScenario(async (tx) => {
      const t = await tree(tx);
      const elsewhere = await task(tx, "Elsewhere", null);
      const eConv = await conversation(
        tx,
        elsewhere,
        "waiting",
        "2026-01-01T00:05:00Z",
      );
      return {
        t,
        eConv,
        byTask: await agentOf(tx, t.a, t.sup),
        byOldConv: await agentOf(tx, t.aOld, t.sup),
        noAgent: await agentOf(tx, t.c, t.sup),
        outside: await agentOf(tx, elsewhere, t.sup),
        self: await agentOf(tx, t.root, t.sup),
        unknown: await agentOf(tx, "task-nowhere", t.sup),
        underRoot: await isUnder(tx, t.c, t.root),
        rootItself: await isUnder(tx, t.root, t.root),
        notUnder: await isUnder(tx, elsewhere, t.root),
      };
    });
    const { t } = got;
    expect(got.byTask).toMatchObject({
      taskId: t.a,
      title: "A",
      conversation: { id: t.aNew },
      self: false,
    });
    expect(got.byOldConv?.conversation?.id).toBe(t.aNew);
    expect(got.noAgent).toMatchObject({ taskId: t.c, conversation: null });
    expect(got.outside?.conversation?.id).toBe(got.eConv);
    expect(got.self?.self).toBe(true);
    expect(got.unknown).toBeNull();
    expect([got.underRoot, got.rootItself, got.notUnder]).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("message: send", () => {
  /** A send from the tree's supervisor to `to`, read the way the tool does. */
  async function send(
    agent: ReturnType<typeof fakeAgent>,
    to: (t: Tree) => string,
    opts: {
      reopen?: boolean;
      setup?: (tx: DbExecutor, t: Tree) => Promise<void>;
    } = {},
  ) {
    return worktreeDbScenario(async (tx) => {
      const t = await tree(tx);
      await opts.setup?.(tx, t);
      const ref = to(t);
      const out = await sendAgentMessage(
        {
          fromConversationId: t.sup,
          sender: await agentOf(tx, t.root, t.sup),
          to: ref,
          target: await agentOf(tx, ref, t.sup),
          text: "push it",
          reopen: opts.reopen,
        },
        agent.ports,
      );
      return { t, out };
    });
  }

  test("by task id: the latest conversation, typed now, no resume", async () => {
    const agent = fakeAgent();
    const got = await send(agent, (t) => t.a);
    expect(got.out).toMatchObject({
      kind: "sent",
      conversationId: got.t.aNew,
      resumed: false,
    });
    expect(agent.resumed).toEqual([]);
    expect(agent.sent).toHaveLength(1);
    expect(agent.sent[0]?.to).toBe(got.t.aNew);
    expect(agent.sent[0]?.text).toContain(
      `Message from the agent on ${got.t.root} "Root"`,
    );
    expect(agent.sent[0]?.text).toContain("push it");
  });

  test("any task, not only the sender's tree", async () => {
    const agent = fakeAgent({ mayReopen: false });
    let eConv = "";
    let elsewhere = "";
    const got = await send(agent, () => elsewhere, {
      setup: async (tx) => {
        elsewhere = await task(tx, "Elsewhere", null);
        eConv = await conversation(
          tx,
          elsewhere,
          "working",
          "2026-01-01T00:05:00Z",
        );
      },
    });
    expect(got.out).toMatchObject({ kind: "sent", conversationId: eConv });
  });

  test("a stopped agent is resumed first; a blocked resume is refused, nothing typed", async () => {
    const ok = fakeAgent({ mayReopen: false });
    expect((await send(ok, (t) => t.bConv)).out).toMatchObject({
      kind: "sent",
      resumed: true,
    });
    expect(ok.resumed).toHaveLength(1);
    expect(ok.sent).toHaveLength(1);

    const blocked = fakeAgent();
    const got = await send(blocked, (t) => t.b, {
      setup: async (_tx, t) => {
        blocked.blocked.add(t.bConv);
      },
    });
    expect(got.out).toMatchObject({
      kind: "refused",
      reason: "resume-blocked",
    });
    expect(blocked.sent).toEqual([]);
  });

  test("a closed agent is refused unless reopened, and reopened only when the sender may", async () => {
    let d = "";
    let dConv = "";
    const setup = async (tx: DbExecutor, t: Tree) => {
      d = await task(tx, "D", t.root);
      dConv = await conversation(tx, d, "done", "2026-01-01T00:04:00Z");
    };

    const refused = fakeAgent();
    expect((await send(refused, () => d, { setup })).out).toMatchObject({
      kind: "refused",
      reason: "closed",
    });
    expect(refused.resumed).toEqual([]);
    expect(refused.sent).toEqual([]);

    const denied = fakeAgent({ mayReopen: false });
    expect(
      (await send(denied, () => d, { setup, reopen: true })).out,
    ).toMatchObject({ kind: "refused", reason: "reopen-denied" });
    expect(denied.resumed).toEqual([]);
    expect(denied.sent).toEqual([]);

    const reopened = fakeAgent();
    const got = await send(reopened, () => d, { setup, reopen: true });
    expect(got.out).toMatchObject({ kind: "sent", resumed: true });
    expect(reopened.resumed).toEqual([dConv]);
    expect(reopened.sent).toHaveLength(1);
  });

  test("refused: an unknown id, oneself, a task no agent ran on", async () => {
    const agent = fakeAgent();
    const [unknown, self, noAgent] = await Promise.all([
      send(agent, () => "task-nowhere"),
      send(agent, (t) => t.root),
      send(agent, (t) => t.c),
    ]);
    expect(unknown.out).toMatchObject({ kind: "refused", reason: "not-found" });
    expect(self.out).toMatchObject({ kind: "refused", reason: "self" });
    expect(noAgent.out).toMatchObject({ kind: "refused", reason: "no-agent" });
    expect(agent.sent).toEqual([]);
    expect(agent.resumed).toEqual([]);
  });
});

describe("message: list_agents cap", () => {
  function agent(
    i: number,
    taskStatus: TreeAgent["taskStatus"],
    status: NonNullable<TreeAgent["conversation"]>["status"],
    self = false,
  ): TreeAgent {
    return {
      taskId: `task-${i}`,
      title: `T${i}`,
      taskStatus,
      conversation: {
        id: `conv-${i}`,
        status,
        waitingFor: null,
        hibernated: false,
        unverified: false,
      },
      self,
    };
  }
  const settled = Array.from({ length: SETTLED_SHOWN + 5 }, (_, i) =>
    agent(i, i % 2 === 0 ? "done" : "dropped", i % 3 === 0 ? "done" : "gone"),
  );
  const agents = [
    agent(100, "done", "done", true),
    ...settled,
    agent(200, "in_progress", "working"),
    agent(201, "need_action", "done"),
  ];

  test("keeps the unsettled, self, and the settled started last", () => {
    const text = renderAgents(agents, { all: false });
    expect(text).toContain("conv-100");
    expect(text).toContain("conv-200");
    expect(text).not.toContain("conv-0 ");
    expect(text).toContain(`conv-${settled.length - 1} `);
    expect(text).toContain("+6 older settled agents");
  });

  test("all lists every agent", () => {
    const text = renderAgents(agents, { all: true });
    expect(text).toContain("conv-0 ");
    expect(text).not.toContain("older settled");
  });
});
