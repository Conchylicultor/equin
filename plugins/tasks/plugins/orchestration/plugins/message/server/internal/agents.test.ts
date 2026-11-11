/**
 * The tree's agents against the REAL worktree DB, inside rolled-back
 * transactions (`worktreeDbScenario`): every task under the root with its
 * latest conversation, the caller's own marked; and the send policy over that
 * read with a fake agent (resume only a stopped one — a closed one only when
 * reopened — refuse outside the tree, oneself, or a task no agent ran on).
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
  agentsUnder,
  renderAgents,
  SETTLED_SHOWN,
  type TreeAgent,
  type TreeAgents,
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

function fakeAgent() {
  const resumed: string[] = [];
  const sent: { to: string; text: string }[] = [];
  const blocked = new Set<string>();
  const ports: MessagePorts = {
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

describe("message: send", () => {
  async function scenario(
    run: (agents: TreeAgents, t: Tree) => Promise<unknown>,
  ) {
    return worktreeDbScenario(async (tx) => {
      const t = await tree(tx);
      const agents = await agentsUnder(tx, t.root, t.sup);
      return run({ kind: "found", rootTaskId: t.root, agents }, t);
    });
  }

  test("by task id: the latest conversation, typed now, no resume", async () => {
    const agent = fakeAgent();
    const got = (await scenario(async (tr, t) => ({
      t,
      out: await sendAgentMessage(tr, t.sup, t.a, "push it", agent.ports),
    }))) as { t: Tree; out: unknown };
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

  test("a stopped agent is resumed first; a blocked resume is refused, nothing typed", async () => {
    const ok = fakeAgent();
    const okOut = await scenario(async (tr, t) => ({
      t,
      out: await sendAgentMessage(tr, t.sup, t.bConv, "redo", ok.ports),
    }));
    expect(okOut).toMatchObject({ out: { kind: "sent", resumed: true } });
    expect(ok.resumed).toHaveLength(1);
    expect(ok.sent).toHaveLength(1);

    const blocked = fakeAgent();
    const blockedOut = await scenario(async (tr, t) => {
      blocked.blocked.add(t.bConv);
      return sendAgentMessage(tr, t.sup, t.b, "redo", blocked.ports);
    });
    expect(blockedOut).toMatchObject({
      kind: "refused",
      reason: "resume-blocked",
    });
    expect(blocked.sent).toEqual([]);
  });

  test("a closed agent is refused unless reopened; reopen resumes it first", async () => {
    async function closed(
      agent: ReturnType<typeof fakeAgent>,
      opts?: { reopen?: boolean },
    ) {
      return worktreeDbScenario(async (tx) => {
        const t = await tree(tx);
        const d = await task(tx, "D", t.root);
        const dConv = await conversation(tx, d, "done", "2026-01-01T00:04:00Z");
        const agents = await agentsUnder(tx, t.root, t.sup);
        return {
          dConv,
          out: await sendAgentMessage(
            { kind: "found", rootTaskId: t.root, agents },
            t.sup,
            d,
            "close with exit_clean",
            agent.ports,
            opts,
          ),
        };
      });
    }

    const refused = fakeAgent();
    expect((await closed(refused)).out).toMatchObject({
      kind: "refused",
      reason: "closed",
    });
    expect(refused.resumed).toEqual([]);
    expect(refused.sent).toEqual([]);

    const reopened = fakeAgent();
    const got = await closed(reopened, { reopen: true });
    expect(got.out).toMatchObject({ kind: "sent", resumed: true });
    expect(reopened.resumed).toEqual([got.dConv]);
    expect(reopened.sent).toHaveLength(1);
  });

  test("refused: outside the tree, oneself, a task no agent ran on, no tree", async () => {
    const agent = fakeAgent();
    const got = await scenario(async (tr, t) => ({
      outside: await sendAgentMessage(
        tr,
        t.sup,
        "task-elsewhere",
        "x",
        agent.ports,
      ),
      self: await sendAgentMessage(tr, t.sup, t.root, "x", agent.ports),
      noAgent: await sendAgentMessage(tr, t.sup, t.c, "x", agent.ports),
      noTree: await sendAgentMessage(
        { kind: "no-tree" },
        t.sup,
        t.a,
        "x",
        agent.ports,
      ),
    }));
    expect(got).toMatchObject({
      outside: { kind: "refused", reason: "not-in-tree" },
      self: { kind: "refused", reason: "self" },
      noAgent: { kind: "refused", reason: "no-agent" },
      noTree: { kind: "refused", reason: "no-tree" },
    });
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
