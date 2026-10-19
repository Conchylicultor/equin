import {
  isAdoptedConversation,
  isBlockedStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import type {
  Conversation,
  TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { QueueData } from "../core";

/** A live conversation carrying its resolved queue rank and pin. */
export type RankedConversation<C extends Conversation = Conversation> = C & {
  rank: Rank;
  pinned: boolean;
};

/** A task-group: every ranked conversation sharing a `taskId`, sharing one rank. */
export type TaskGroup<C extends Conversation = Conversation> = {
  taskId: string;
  selected: RankedConversation<C>;
  members: RankedConversation<C>[];
  count: number;
};

/**
 * The settled classification of the queue, partitioned into read-time sections.
 * `C` is the conversation row as read (with whatever it carries beside the
 * conversation — its exposed `$columns`), handed back as is.
 */
export interface ClassifiedQueue<C extends Conversation = Conversation> {
  pinnedGroups: TaskGroup<C>[];
  waitingGroups: TaskGroup<C>[];
  workingGroups: TaskGroup<C>[];
  /**
   * Running conversations with no queue rank yet (a fresh launch before its
   * rank is seeded, or one whose seed never ran). Still Working: the section
   * answers "what is running right now", which does not depend on a rank.
   */
  workingUnranked: C[];
  allWaitingCount: number;
  blockedIds: Set<string>;
  unranked: C[];
  /**
   * Live conversations nothing launched: sessions main found running and
   * adopted (`isAdoptedConversation`) — typically an agent's own
   * `tmux new-session` from its checkout. Kept out of the ranked sections
   * whatever their rank or status, so they are visible without passing for
   * the user's work.
   */
  lost: C[];
  /**
   * Gone conversations whose spawn job recorded a failure: the launch never
   * started a session, so there is nothing to resume — kept apart from
   * Disconnected, which promises a session to resume.
   */
  failedToStart: C[];
  disconnected: C[];
  recentGone: C[];
}

/**
 * Pure, React-free queue classification — the single source of truth for how
 * live conversations, their queue ranks, and their tasks partition into the
 * queue's read-time sections (Pinned / Queue / Working / Lost / Unranked /
 * Failed to start / Disconnected / Done), grouped by `taskId` with a shared rank per group.
 *
 * A pin only moves a WAITING group into its own section: an active group belongs
 * in Working whether or not it is pinned, since Working answers "what is running
 * right now" and the pin answers "what do I want to keep in reach".
 *
 * Kept free of React and of the DataView so the partitioning stays testable and
 * reusable by any presentation of the queue.
 */
export function classifyQueue<C extends Conversation>(data: {
  active: C[];
  gone: C[];
  queue: QueueData;
  tasks: TaskListItem[];
  /** The ids, among the gone `active` rows, that carry a spawn failure. */
  spawnFailedIds: ReadonlySet<string>;
}): ClassifiedQueue<C> {
  const { active, gone, queue, tasks, spawnFailedIds } = data;
  const ranks = new Map(queue.ranks.map((r) => [r.conversationId, r]));
  const taskStatusMap = new Map(tasks.map((t) => [t.id, t.status]));
  const ranked: RankedConversation<C>[] = [];
  const blocked = new Set<string>();
  const noRank: C[] = [];
  const workingNoRank: C[] = [];
  const lost: C[] = [];

  for (const c of active) {
    if (
      c.status !== "waiting" &&
      c.status !== "working" &&
      c.status !== "starting"
    )
      continue;
    if (isAdoptedConversation(c)) {
      lost.push(c);
      continue;
    }
    // A live conversation's task reports the RUNNING half of blocked
    // (`in_progress_blocked`), so this must ask the predicate — matching the
    // `"blocked"` literal alone would mark nothing here.
    const taskStatus = taskStatusMap.get(c.taskId);
    if (taskStatus !== undefined && isBlockedStatus(taskStatus)) {
      blocked.add(c.id);
    }
    const row = ranks.get(c.id);
    if (row) {
      ranked.push({ ...c, rank: row.rank, pinned: row.pinned });
    } else if (c.status === "waiting") {
      noRank.push(c);
    } else {
      workingNoRank.push(c);
    }
  }
  ranked.sort((a, b) => Rank.compare(a.rank, b.rank));

  // Group by taskId
  const taskMap = new Map<string, RankedConversation<C>[]>();
  for (const conv of ranked) {
    const list = taskMap.get(conv.taskId);
    if (list) list.push(conv);
    else taskMap.set(conv.taskId, [conv]);
  }

  const pinnedWaiting: TaskGroup<C>[] = [];
  const waiting: TaskGroup<C>[] = [];
  const working: TaskGroup<C>[] = [];
  let waitingCount = 0;
  for (const [taskId, members] of taskMap) {
    if (members.length === 0) continue;
    const workingMember = members.find(
      (m) => m.status === "working" || m.status === "starting",
    );
    const mostRecent = members.reduce((a, b) =>
      b.createdAt > a.createdAt ? b : a,
    );
    const selected = workingMember ?? mostRecent;
    const group: TaskGroup<C> = {
      taskId,
      selected,
      members,
      count: members.length,
    };
    if (workingMember) {
      working.push(group);
    } else {
      // The pin is written to every live member of a group, so any member
      // answers for the group.
      (selected.pinned ? pinnedWaiting : waiting).push(group);
      waitingCount += members.filter((m) => m.status === "waiting").length;
    }
  }
  const byRank = (a: TaskGroup<C>, b: TaskGroup<C>): number =>
    Rank.compare(a.selected.rank, b.selected.rank);
  pinnedWaiting.sort(byRank);
  waiting.sort(byRank);
  working.sort(byRank);

  return {
    pinnedGroups: pinnedWaiting,
    waitingGroups: waiting,
    workingGroups: working,
    workingUnranked: workingNoRank,
    allWaitingCount: waitingCount,
    blockedIds: blocked,
    unranked: noRank,
    lost,
    failedToStart: active.filter(
      (c) => c.status === "gone" && spawnFailedIds.has(c.id),
    ),
    disconnected: active.filter(
      (c) => c.status === "gone" && !spawnFailedIds.has(c.id),
    ),
    recentGone: gone,
  };
}
