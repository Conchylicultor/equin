import { describe, expect, test } from "bun:test";
import type { SpendNode } from "../../core";
import { buildSpendTree, callerName, type SpendSourceRow } from "./tree";

const MANDATES = { roleSession: "supervisor-role", adhoc: "supervisor" };

function conv(
  id: string,
  cost: number,
  over: Partial<SpendSourceRow> = {},
): SpendSourceRow {
  return {
    source: `conv:${id}`,
    costUsd: cost,
    billedUsd: 0,
    caller: null,
    conversation: { id, title: `Conversation ${id}`, live: false },
    attempt: null,
    task: null,
    mandateId: null,
    root: null,
    role: null,
    automationId: null,
    ...over,
  };
}

function cli(caller: string, cost: number): SpendSourceRow {
  return {
    ...conv("x", cost),
    source: `cli:${caller}`,
    caller,
    conversation: null,
  };
}

const at = (node: SpendNode, ...ids: string[]): SpendNode =>
  ids.reduce((n, id) => {
    const next = n.children.find((c) => c.id === id);
    if (!next)
      throw new Error(
        `no ${id} under ${n.id}: ${n.children.map((c) => c.id).join(", ")}`,
      );
    return next;
  }, node);

const harnessRole = { id: "srole-h", name: "Harness", session: 7 };
const sessionRoot = { id: "task-s7", title: "Harness session" };

describe("buildSpendTree", () => {
  const tree = buildSpendTree(
    [
      // A role session's own conversation, and two workers (one with two attempts).
      conv("c-s", 28, {
        attempt: { id: "att-s", number: 1 },
        task: sessionRoot,
        root: sessionRoot,
        mandateId: "supervisor-role",
        role: harnessRole,
        conversation: { id: "c-s", title: "Session chat", live: true },
      }),
      conv("c-w1a", 30, {
        attempt: { id: "att-w1a", number: 1 },
        task: { id: "task-w1", title: "Cold cache" },
        root: sessionRoot,
        mandateId: "supervisor-role",
        role: harnessRole,
      }),
      conv("c-w1b", 16, {
        attempt: { id: "att-w1b", number: 2 },
        task: { id: "task-w1", title: "Cold cache" },
        root: sessionRoot,
        mandateId: "supervisor-role",
        role: harnessRole,
      }),
      // An ad-hoc supervisor root's own conversation.
      conv("c-a", 14, {
        attempt: { id: "att-a", number: 1 },
        task: { id: "task-a", title: "Icon migration" },
        root: { id: "task-a", title: "Icon migration" },
        mandateId: "supervisor",
      }),
      // An automation's task, and two background callers.
      conv("c-auto", 18, {
        attempt: { id: "att-auto", number: 1 },
        task: { id: "task-auto", title: "Investigate report" },
        root: { id: "task-auto", title: "Investigate report" },
        mandateId: "interactive",
        automationId: "reports-investigation",
      }),
      cli("task-title", 11),
      cli("turn-summary", 9),
      // The person's own: a task, and a conversation with no task.
      conv("c-you", 64, {
        attempt: { id: "att-you", number: 1 },
        task: { id: "task-you", title: "Boot performance" },
        root: { id: "task-you", title: "Boot performance" },
        mandateId: "interactive",
      }),
      conv("c-loose", 2),
      // Nothing spent: left out.
      conv("c-zero", 0),
    ],
    MANDATES,
  );

  test("the root sums every source; categories keep their fixed order", () => {
    expect(tree.costUsd).toBe(28 + 30 + 16 + 14 + 18 + 11 + 9 + 64 + 2);
    expect(tree.children.map((c) => c.id)).toEqual([
      "supervisors",
      "adhoc",
      "background",
      "you",
    ]);
    expect(at(tree, "adhoc").short).toBe("Ad hoc");
  });

  test("a role session: the session itself vs its workers, then attempts", () => {
    const role = at(tree, "supervisors", "srole-h");
    expect(role.costUsd).toBe(74);
    expect(role.live).toBe(true);
    expect(role.sub).toBe("Session 7 · 1 worker");
    // The worker (46) before the session (28): ordered by cost.
    expect(role.children.map((c) => c.id)).toEqual([
      "task-w1",
      "session:task-s7",
    ]);
    // One conversation alone: the session is that conversation's leaf.
    const session = at(role, "session:task-s7");
    expect(session.name).toBe("Session 7");
    expect(session.conversationId).toBe("c-s");
    expect(session.children).toEqual([]);
    const worker = at(role, "task-w1");
    expect(worker.sub).toBe("2 attempts");
    expect(worker.children.map((c) => [c.name, c.conversationId])).toEqual([
      ["Attempt 1", "c-w1a"],
      ["Attempt 2", "c-w1b"],
    ]);
  });

  test("an ad-hoc root, an automation's task and background callers", () => {
    // Its session alone, one conversation: the root opens it.
    expect(at(tree, "adhoc", "task-a").conversationId).toBe("c-a");
    const auto = at(tree, "background", "reports-investigation");
    expect(auto.kind).toBe("automation");
    expect(at(auto, "task-auto").conversationId).toBe("c-auto");
    const titles = at(tree, "background", "cli:task-title");
    expect(titles.kind).toBe("caller");
    expect(titles.name).toBe("Task title");
  });

  test("the person's own: a task opens its conversation; no task is a leaf of You", () => {
    expect(at(tree, "you", "task-you").conversationId).toBe("c-you");
    expect(at(tree, "you", "c-loose").conversationId).toBe("c-loose");
  });

  test("a level shows its five biggest parts and folds the rest", () => {
    const many = buildSpendTree(
      Array.from({ length: 8 }, (_, i) => conv(`c${i}`, i + 1)),
      MANDATES,
    );
    const you = at(many, "you");
    expect(you.children.map((c) => c.id)).toEqual([
      "c7",
      "c6",
      "c5",
      "c4",
      "c3",
      "rest",
    ]);
    const rest = at(you, "rest");
    expect(rest.name).toBe("3 more conversations");
    expect(rest.count).toBe(3);
    expect(rest.costUsd).toBe(1 + 2 + 3);
    expect(you.sub).toBe("8 conversations");
  });

  test("billed (API-key) spend is carried up the tree", () => {
    const billed = buildSpendTree(
      [{ ...conv("c1", 10), billedUsd: 4 }, conv("c2", 5)],
      MANDATES,
    );
    expect(billed.billedUsd).toBe(4);
    expect(at(billed, "you").billedUsd).toBe(4);
  });

  test("no spend: no categories", () => {
    expect(buildSpendTree([], MANDATES).children).toEqual([]);
  });
});

describe("callerName", () => {
  test("a caller's id, in words", () => {
    expect(callerName("task-title")).toBe("Task title");
    expect(callerName("page-auto-icon")).toBe("Page auto icon");
  });
});
