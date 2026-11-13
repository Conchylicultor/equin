import { describe, expect, test } from "bun:test";
import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  PINNED_SECTION,
  conversationSectionIdKind,
  type QueueData,
} from "../core";
import { classifyQueue } from "./classify-queue";

const conv = (o: Partial<Conversation> & { id: string }): Conversation =>
  ({
    status: "waiting",
    waitingFor: null,
    taskId: `task-${o.id}`,
    launchCause: "direct",
    launchedFrom: null,
    createdAt: new Date(0),
    ...o,
  }) as Conversation;

const rankRow = (
  conversationId: string,
  section: string | null = null,
  rank: Rank = Rank.between(null, null),
): QueueData["ranks"][number] =>
  ({
    conversationId,
    rank,
    section,
  }) as QueueData["ranks"][number];

describe("classifyQueue — Lost", () => {
  test("adopted live conversations are Lost, whatever their rank or status", () => {
    const launched = conv({ id: "conv-1" });
    const lostWaiting = conv({ id: "spike-a", launchCause: "adopted" });
    const lostWorking = conv({
      id: "spike-b",
      status: "working",
      launchCause: "adopted",
    });
    const q = classifyQueue({
      active: [launched, lostWaiting, lostWorking],
      gone: [],
      // An adopted conversation seeded before Lost existed still has a rank.
      queue: { ranks: [rankRow("conv-1"), rankRow("spike-a")] },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [],
      supervisingTaskIds: new Set(),
    });
    expect(q.lost.map((c) => c.id)).toEqual(["spike-a", "spike-b"]);
    expect(q.waitingGroups.map((g) => g.selected.id)).toEqual(["conv-1"]);
    expect(q.workingGroups).toEqual([]);
    expect(q.workingUnranked).toEqual([]);
    expect(q.unranked).toEqual([]);
  });

  test("a closed adopted conversation is not Lost", () => {
    const q = classifyQueue({
      active: [conv({ id: "spike-a", status: "gone", launchCause: "adopted" })],
      gone: [],
      queue: { ranks: [] },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [],
      supervisingTaskIds: new Set(),
    });
    expect(q.lost).toEqual([]);
    expect(q.disconnected.map((c) => c.id)).toEqual(["spike-a"]);
  });
});

describe("classifyQueue — Failed to start", () => {
  test("a gone conversation with a spawn failure is Failed to start, not Disconnected", () => {
    const q = classifyQueue({
      active: [
        conv({ id: "conv-failed", status: "gone" }),
        conv({ id: "conv-ran", status: "gone" }),
        // A failure recorded on a conversation a later retry started: it is
        // live, so the failure does not move it.
        conv({ id: "conv-retried", status: "waiting" }),
      ],
      gone: [],
      queue: { ranks: [rankRow("conv-retried")] },
      tasks: [],
      spawnFailedIds: new Set(["conv-failed", "conv-retried"]),
      sectionIds: [],
      supervisingTaskIds: new Set(),
    });
    expect(q.failedToStart.map((c) => c.id)).toEqual(["conv-failed"]);
    expect(q.disconnected.map((c) => c.id)).toEqual(["conv-ran"]);
    expect(q.waitingGroups.map((g) => g.selected.id)).toEqual(["conv-retried"]);
  });
});

describe("classifyQueue — sections", () => {
  const mine = conversationSectionIdKind.mint();
  const empty = conversationSectionIdKind.mint();
  const r1 = Rank.between(null, null);
  const r2 = Rank.between(r1, null);
  const r3 = Rank.between(r2, null);

  test("a waiting group goes to its section: Pinned, a known user section, else the Queue", () => {
    const q = classifyQueue({
      active: [
        conv({ id: "pinned" }),
        conv({ id: "mine-b" }),
        conv({ id: "mine-a" }),
        conv({ id: "queued" }),
        conv({ id: "stale" }),
      ],
      gone: [],
      queue: {
        ranks: [
          rankRow("pinned", PINNED_SECTION, r1),
          rankRow("mine-b", mine, r3),
          rankRow("mine-a", mine, r2),
          rankRow("queued", null, r1),
          // A section deleted under a stale read: the Queue, never lost.
          rankRow("stale", "csec-gone", r2),
        ],
      },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [mine, empty],
      supervisingTaskIds: new Set(),
    });
    expect(q.pinnedGroups.map((g) => g.selected.id)).toEqual(["pinned"]);
    expect([...q.sectionGroups.keys()]).toEqual([mine, empty]);
    expect(q.sectionGroups.get(mine)!.map((g) => g.selected.id)).toEqual([
      "mine-a",
      "mine-b",
    ]);
    expect(q.sectionGroups.get(empty)).toEqual([]);
    expect(q.waitingGroups.map((g) => g.selected.id)).toEqual([
      "queued",
      "stale",
    ]);
  });

  test("a working group is Working whatever section it is filed into", () => {
    const q = classifyQueue({
      active: [
        conv({ id: "run-pinned", status: "working" }),
        conv({ id: "run-mine", status: "working" }),
      ],
      gone: [],
      queue: {
        ranks: [
          rankRow("run-pinned", PINNED_SECTION, r1),
          rankRow("run-mine", mine, r2),
        ],
      },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [mine],
      supervisingTaskIds: new Set(),
    });
    expect(q.workingGroups.map((g) => g.selected.id)).toEqual([
      "run-pinned",
      "run-mine",
    ]);
    expect(q.pinnedGroups).toEqual([]);
    expect(q.sectionGroups.get(mine)).toEqual([]);
  });
});

describe("classifyQueue — supervisors", () => {
  test("a waiting supervisor of running work is Working, whatever its section", () => {
    const q = classifyQueue({
      active: [
        conv({ id: "sup-pinned", taskId: "task-sup-pinned" }),
        conv({ id: "sup-queued", taskId: "task-sup-queued" }),
        conv({ id: "idle-sup", taskId: "task-idle-sup" }),
      ],
      gone: [],
      queue: {
        ranks: [
          rankRow("sup-pinned", PINNED_SECTION, Rank.between(null, null)),
          rankRow("sup-queued"),
          rankRow("idle-sup"),
        ],
      },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [],
      supervisingTaskIds: new Set(["task-sup-pinned", "task-sup-queued"]),
    });
    expect(q.workingGroups.map((g) => g.selected.id).sort()).toEqual([
      "sup-pinned",
      "sup-queued",
    ]);
    // Its own status is untouched: it is still waiting.
    expect(q.workingGroups.every((g) => g.selected.status === "waiting")).toBe(
      true,
    );
    expect(q.pinnedGroups).toEqual([]);
    expect(q.waitingGroups.map((g) => g.selected.id)).toEqual(["idle-sup"]);
  });

  test("a supervisor asking the user something stays among the waiting", () => {
    const q = classifyQueue({
      active: [conv({ id: "sup", taskId: "task-sup", waitingFor: "question" })],
      gone: [],
      queue: { ranks: [rankRow("sup")] },
      tasks: [],
      spawnFailedIds: new Set(),
      sectionIds: [],
      supervisingTaskIds: new Set(["task-sup"]),
    });
    expect(q.workingGroups).toEqual([]);
    expect(q.waitingGroups.map((g) => g.selected.id)).toEqual(["sup"]);
  });
});
