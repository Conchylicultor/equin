import { useLive } from "@plugins/network/plugins/live/web";
import type { WithContributedColumns } from "@plugins/network/plugins/live/core";
import { useMemo, useState } from "react";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import {
  conversationsActive,
  conversationsGone,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  combineResources,
  foldResource,
  type ResourceReadiness,
} from "@plugins/primitives/plugins/live-state/web";
import { useOptimisticResource } from "@plugins/primitives/plugins/optimistic-mutation/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  useLivePagesPaging,
  type DataViewPaging,
} from "@plugins/primitives/plugins/data-view/web";
import {
  queueRanks,
  reorderQueue,
  type QueueData,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import {
  applyReorder,
  classifyQueue,
  type ReorderVars,
  type TaskGroup,
} from "@plugins/conversations/plugins/conversations-view/plugins/queue/web";
import { reuseRows } from "./reuse-rows";

/** The read-time section a queue row belongs to (the enum the `section` field partitions by). */
export type QueueSection =
  | "pinned"
  | "queued"
  | "working"
  | "lost"
  | "unranked"
  | "disconnected"
  | "done";

/**
 * A conversation as both queue reads deliver it: its exposed fields (the
 * task's track) ride under `$columns` (`conversationsActive` /
 * `conversationsGone` declare `exposes`), which the Queue's DataView reads
 * through its `collection`.
 */
type QueueConversation = WithContributedColumns<Conversation>;

/**
 * One flat DataView row per conversation. Extends {@link Conversation} with the
 * section classification + the group-level queue flags (set identically on every
 * member of a task-group, so whichever member the aggregate picks as the
 * representative carries the right flags). `rank` is non-null ONLY in the
 * `pinned`/`queued` sections (drives manual-order drag); `null` everywhere else
 * marks the row non-draggable (primitive P1). `pinned` is the user's own flag and
 * is carried on EVERY section's rows, so the unpin action is reachable from
 * Working too — a pinned group that starts running comes back to Pinned when it
 * finishes.
 */
export type QueueRow = QueueConversation & {
  section: QueueSection;
  rank: Rank | null;
  pinned: boolean;
  isTop: boolean;
  isBottom: boolean;
  canStepDown: boolean;
  isBlocked: boolean;
  memberCount: number;
};

/**
 * The computed queue display, and the reorder that was made against it. The
 * dispatch is kept WITH the display it belongs to: while a live-set change
 * re-baselines the ranks read (pending again, for one round trip) the sidebar
 * keeps painting this display, and a drag made on it is an op against ranks
 * the user did see — so it goes through the same overlay, which replays it on
 * the new tuple's base once that lands.
 */
type QueueDisplay = {
  rows: QueueRow[];
  dispatchReorder: (vars: ReorderVars) => void;
};

/** The display shown, and the computation it was reconciled from. */
type HeldDisplay = { from: QueueDisplay; display: QueueDisplay };

/**
 * Combines the queue's live resources — active + gone conversations (gone read
 * as live pages, so the Done section pages as the user scrolls, kept live
 * where it is on screen), tasks, and
 * the bounded POINT ranks (subscribed to the LIVE conversation id set, replayed
 * through the optimistic overlay) — runs the shared {@link classifyQueue}, and
 * flattens the classification into one `QueueRow[]` in display order (Pinned,
 * Queue, Working, Lost, Unranked, Disconnected, Done).
 * Task-group members are emitted representative-first so the aggregate entry's key
 * equals the representative id (selection-highlight parity with the classic view).
 */
export function useQueueRows(): {
  rows: QueueRow[];
  dispatchReorder: (vars: ReorderVars) => void;
  /** The state of the reads behind `rows` — hand it to DataView's `readiness`. */
  readiness: ResourceReadiness;
  /** How the Done section pages — hand it to DataView's `paging`. */
  paging: DataViewPaging<QueueRow> | undefined;
} {
  const activeResult = useLive(conversationsActive);
  // The ended conversations (the Done section), newest first, as live pages:
  // the first page is the default window, the rest load as the user scrolls
  // past the tail, and only those near the Done rows on screen stay live —
  // the DataView reports them to `paging.viewport`. Gated like the other
  // reads through a `ResourceResult` view of it.
  const { pages: gonePages, paging: gonePaging } = useLivePagesPaging(
    conversationsGone,
    GONE_QUERY,
  );
  const goneResult = useMemo(
    () =>
      gonePages.status === "ready"
        ? { status: "ready" as const, data: [...gonePages.rows] }
        : gonePages,
    [gonePages],
  );
  // How many have ended in all — the Done section's exact count before every
  // page is loaded: every ended conversation is a "done" row, so grouped by
  // `section` the unloaded ones land in Done (`uniform`).
  const goneCount = useLive(conversationsGone, GONE_COUNT);
  // Not known yet (or failed with nothing seen): no total, so Done reads as
  // the lower bound it still is.
  const goneTotal = foldResource(goneCount, {
    ready: (n) => n,
    loading: () => null,
    error: (_error, stale) => stale ?? null,
  });
  const paging = useMemo(
    (): DataViewPaging<QueueRow> | undefined =>
      gonePaging === null
        ? undefined
        : {
            ...gonePaging,
            isPaged: (r: QueueRow) => r.section === "done",
            total:
              goneTotal === null
                ? null
                : { count: goneTotal, uniform: GONE_UNIFORM },
          },
    [gonePaging, goneTotal],
  );
  const tasksResult = useLive(taskRows);

  // The live conversation id set the queue already tracks — `null` (not a fake
  // empty) while active is still pending, so a pending live set is never confused
  // with a genuinely-empty one. The all-or-nothing gate below (which includes
  // `activeResult`) keeps the whole hook pending until active settles.
  const liveIds = useMemo<string[] | null>(() => {
    if (activeResult.status === "loading" || activeResult.status === "error")
      return null;
    return activeResult.data.map((c) => c.id);
  }, [activeResult]);
  // The ranks of the live set, as an id set of the collection. A pending live
  // set reads the empty set — a valid EMPTY point subscription (no query), never
  // surfaced because the gate stays pending until active settles. The id set
  // is encoded canonically (sorted, deduped), so its order does not matter.
  const ranksResult = useOptimisticResource(
    queueRanks,
    { ids: liveIds ?? [] },
    {
      apply: applyReorder,
      // Exact-ack confirmation: a point delta carries no snapshot watermark, so
      // the reorder endpoint's returned `{ watermark }` is matched against the
      // frames' ackTx via the tx-ack registry — no isConfirmedBy needed. A
      // write that changes nothing in this id set is acked by a standalone
      // frame, which the hook asks the server for on its own.
      mutate: (vars: ReorderVars) =>
        fetchEndpoint(reorderQueue, {}, { body: vars }),
    },
  );

  // All-or-nothing gate over the four live resources, memoized on their STABLE
  // result identities (each `useLive`/`useOptimisticResource` result is
  // referentially stable when its data/status is unchanged). This stability is
  // load-bearing: the retain-last set-during-render below relies on `computed`
  // being a stable object between renders, so it fires only on genuine changes and
  // terminates. `null` early-returns (never a fake-empty) so a pending resource is
  // never confused with an empty one.
  const computed = useMemo<QueueDisplay | null>(() => {
    const all = combineResources({
      active: activeResult,
      gone: goneResult,
      ranks: ranksResult,
      tasks: tasksResult,
    });
    if (all.status === "loading" || all.status === "error") return null;
    // Already settled per the combine above; this narrows the optimistic
    // result to its `ready` arm, the one carrying `dispatch`.
    if (ranksResult.status === "loading" || ranksResult.status === "error")
      return null;
    const { active, gone, ranks, tasks } = all.data;

    // Wrap the point ranks in the client-side `QueueData` shape so
    // `classifyQueue` (the shared source of truth) stays UNCHANGED.
    const queue: QueueData = { ranks };
    const {
      pinnedGroups,
      waitingGroups,
      workingGroups,
      workingUnranked,
      blockedIds,
      unranked,
      lost,
      disconnected,
      recentGone,
    } = classifyQueue({ active, gone, queue, tasks });

    const out: QueueRow[] = [];

    // Representative first, then the remaining members — so the aggregate entry's
    // key equals the representative id. Group-level flags apply to every member.
    const emitGroup = (
      group: TaskGroup<QueueConversation>,
      section: QueueSection,
      flags: {
        ranked: boolean;
        isTop: boolean;
        isBottom: boolean;
        canStepDown: boolean;
        isBlocked: boolean;
      },
    ): void => {
      const ordered = [
        group.selected,
        ...group.members.filter((m) => m.id !== group.selected.id),
      ];
      for (const m of ordered) {
        out.push({
          ...m,
          section,
          rank: flags.ranked ? m.rank : null,
          pinned: m.pinned,
          isTop: flags.isTop,
          isBottom: flags.isBottom,
          canStepDown: flags.canStepDown,
          isBlocked: flags.isBlocked,
          memberCount: group.count,
        });
      }
    };

    const emitFlat = (conv: QueueConversation, section: QueueSection): void => {
      out.push({
        ...conv,
        section,
        rank: null,
        pinned: false,
        isTop: false,
        isBottom: false,
        canStepDown: false,
        isBlocked: false,
        memberCount: 1,
      });
    };

    // 1. pinned — the waiting clusters the user pinned (rank asc). Its own rank
    // space for the top/bottom affordances: a pinned row's neighbours are the
    // other pinned rows, which is what "move to top" means while it is up there.
    pinnedGroups.forEach((group, idx) => {
      emitGroup(group, "pinned", {
        ranked: true,
        isTop: idx === 0,
        isBottom: idx === pinnedGroups.length - 1,
        canStepDown: idx < pinnedGroups.length - 1,
        isBlocked: blockedIds.has(group.selected.id),
      });
    });

    // 2. queued — the unpinned waiting clusters (rank asc).
    waitingGroups.forEach((group, idx) => {
      emitGroup(group, "queued", {
        ranked: true,
        isTop: idx === 0,
        isBottom: idx === waitingGroups.length - 1,
        canStepDown: idx < waitingGroups.length - 1,
        isBlocked: blockedIds.has(group.selected.id),
      });
    });

    // 3. working — non-draggable (rank null).
    for (const group of workingGroups) {
      emitGroup(group, "working", {
        ranked: false,
        isTop: false,
        isBottom: false,
        canStepDown: false,
        isBlocked: false,
      });
    }
    for (const conv of workingUnranked) emitFlat(conv, "working");

    // 4–7. flat sections (keep incoming order).
    for (const conv of lost) emitFlat(conv, "lost");
    for (const conv of unranked) emitFlat(conv, "unranked");
    for (const conv of disconnected) emitFlat(conv, "disconnected");
    for (const conv of recentGone) emitFlat(conv, "done");

    return { rows: out, dispatchReorder: ranksResult.dispatch };
  }, [activeResult, goneResult, ranksResult, tasksResult]);

  // The display actually shown, derived from the last settled `computed`:
  //
  // - Row identity: each recompute rebuilds every row object, so the rows are
  //   reconciled onto the previous display's (`reuseRows`) — an unchanged
  //   conversation keeps its row object (and an unchanged queue its array), and
  //   the list, which memoizes each row on its row object, re-renders only the
  //   rows that changed.
  // - Flash mitigation: the live-set changing re-baselines the ranks
  //   subscription (a new point tuple ⇒ a pending arm). The last settled display
  //   is retained so a re-subscription paints the previous rows instead of
  //   blanking to a skeleton.
  //
  // Both need the previous display, so it is state, updated with React's
  // sanctioned "store info from previous renders" pattern — a guarded
  // set-during-render. That is not an extra render pass: React re-runs this
  // hook's component immediately, before rendering any child or committing, so
  // the children draw once, from the reconciled rows. It terminates because
  // `computed` is a stable memoized object while the inputs are unchanged
  // (`computed === held.from` ⇒ no set). On true first mount (no retained
  // value) the display stays null and the hook reports `pending`.
  const [held, setHeld] = useState<HeldDisplay | null>(null);
  let current = held;
  if (computed && computed !== held?.from) {
    current = {
      from: computed,
      display: {
        rows: reuseRows(held?.display.rows ?? null, computed.rows),
        dispatchReorder: computed.dispatchReorder,
      },
    };
    setHeld(current);
  }
  const lastGood = current?.display ?? null;

  // A FAILED read is never papered over by the retained display: the retention
  // exists for the brief loading re-baseline, and a failure shown as the old
  // rows (or as a skeleton) would hide that the queue stopped updating.
  const gate = combineResources({
    active: activeResult,
    gone: goneResult,
    ranks: ranksResult,
    tasks: tasksResult,
  });
  let display: QueueDisplay | null;
  let readiness: ResourceReadiness;
  switch (gate.status) {
    case "error":
      display = null;
      readiness = gate;
      break;
    case "loading":
      display = lastGood;
      readiness = lastGood === null ? gate : { status: "ready" };
      break;
    case "ready":
      // `computed` is settled here, so `lastGood` is its reconciled form.
      display = lastGood;
      readiness = gate;
      break;
  }

  return {
    rows: display?.rows ?? [],
    dispatchReorder: display?.dispatchReorder ?? noReorder,
    readiness,
    paging,
  };
}

// The pages' query: the collection's default order, every ended conversation.
const GONE_QUERY = {};
// The same set's total.
const GONE_COUNT = { count: true } as const;
// The fields every Done row shares a value of.
const GONE_UNIFORM: readonly string[] = ["section"];

// No display yet: nothing is on screen to drag, so there is nothing to reorder.
function noReorder(): void {
  throw new Error(
    "useQueueRows: a reorder was dispatched before the queue rendered",
  );
}
