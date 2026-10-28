import { describe, expect, test } from "bun:test";
import {
  DIGEST_LINE_CAP,
  taskTreeOn,
  treeDigestOn,
  type DigestAnnotate,
  type DigestStore,
  type DigestTask,
} from "./digest";

// The digest policy over an in-memory store: a logical clock stands in for the
// database's, and a task's `changedAt` for its created/updated stamps.

const CONV = "conv-1";
const ROOT = "R";

interface MemTask extends DigestTask {
  changedAt: number;
}

function makeStore() {
  let now = 1;
  const tasks = new Map<string, MemTask>();
  const cursors = new Map<string, number>();
  const put = (id: string, folderId: string | null, rank: string) => {
    tasks.set(id, {
      id,
      folderId,
      rank,
      title: `Task ${id}`,
      status: "new",
      changedAt: now++,
    });
  };
  const touch = (id: string, status: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(id);
    tasks.set(id, { ...t, status, changedAt: now++ });
  };
  const inSubtree = (t: MemTask): boolean => {
    let cur: MemTask | undefined = t;
    while (cur) {
      if (cur.id === ROOT) return true;
      cur = cur.folderId === null ? undefined : tasks.get(cur.folderId);
    }
    return false;
  };
  const store: DigestStore = {
    scopeOf: async (id) =>
      id === CONV ? { taskId: "A", rootTaskId: ROOT } : null,
    cursorOf: async (c, r) => {
      const at = cursors.get(`${c}|${r}`);
      return at === undefined ? null : new Date(at);
    },
    subtree: async () => ({
      tasks: [...tasks.values()].filter(inSubtree),
      at: new Date(now++),
    }),
    changedSince: async (_r, since) => {
      const at = new Date(now++);
      return {
        tasks: [...tasks.values()].filter(
          (t) => inSubtree(t) && t.changedAt > since.getTime(),
        ),
        at,
      };
    },
    advance: async (c, r, at) => {
      cursors.set(`${c}|${r}`, at.getTime());
    },
  };
  return { store, put, touch, cursors };
}

const annotate: DigestAnnotate = async (ts) =>
  new Map(ts.filter((t) => t.id === "B").map((t) => [t.id, ["armed"]]));

describe("treeDigest", () => {
  test("first the whole subtree, in tree order; then only what changed", async () => {
    const s = makeStore();
    s.put(ROOT, null, "a");
    s.put("A", ROOT, "b");
    s.put("B", "A", "a");
    s.put("C", ROOT, "a");
    s.put("X", null, "z"); // outside the subtree

    const first = await treeDigestOn(s.store, {
      conversationId: CONV,
      annotate,
    });
    expect(first?.full).toBe(true);
    expect(first?.text.split("\n")).toEqual([
      `Your task tree (root ${ROOT}):`,
      `- R "Task R" — new`,
      `  - C "Task C" — new`,
      `  - A "Task A" — new, your task`,
      `    - B "Task B" — new, armed`,
    ]);

    const quiet = await treeDigestOn(s.store, {
      conversationId: CONV,
      annotate,
    });
    expect(quiet?.full).toBe(false);
    expect(quiet?.text).toMatch(/No task in your tree changed/);

    s.touch("C", "in_progress");
    s.put("D", "A", "c");
    s.touch("X", "done"); // outside: never shown
    const delta = await treeDigestOn(s.store, {
      conversationId: CONV,
      annotate,
    });
    expect(delta?.full).toBe(false);
    expect(delta?.text.split("\n")).toEqual([
      "Changed in your task tree since you last saw it:",
      `- C "Task C" — in_progress`,
      `- D "Task D" — new`,
    ]);
  });

  test("caps at the line limit and points at task_tree; task_tree shows all and keeps the cursor", async () => {
    const s = makeStore();
    s.put(ROOT, null, "a");
    s.put("A", ROOT, "a");
    for (let i = 0; i < 50; i++)
      s.put(
        `T${String(i).padStart(2, "0")}`,
        ROOT,
        `b${String(i).padStart(2, "0")}`,
      );

    const tree = await taskTreeOn(s.store, { conversationId: CONV, annotate });
    expect(tree?.split("\n")).toHaveLength(1 + 52);
    expect(s.cursors.size).toBe(0);

    const digest = await treeDigestOn(s.store, {
      conversationId: CONV,
      annotate,
    });
    const lines = digest?.text.split("\n") ?? [];
    expect(lines).toHaveLength(1 + DIGEST_LINE_CAP + 1);
    expect(lines.at(-1)).toBe(
      `+${52 - DIGEST_LINE_CAP} more — call \`task_tree\` for the whole tree`,
    );
    expect(s.cursors.size).toBe(1);
  });

  test("a conversation without a task has no digest", async () => {
    const s = makeStore();
    expect(
      await treeDigestOn(s.store, { conversationId: "other", annotate }),
    ).toBeNull();
  });
});
