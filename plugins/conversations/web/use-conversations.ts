import { useCallback, useMemo } from "react";
import {
  foldResource,
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { mapRow, useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import {
  conversationsActive,
  conversationsById,
  conversationsSystem,
  conversationsGone,
} from "@plugins/tasks/plugins/tasks-core/core";
import { isActiveStatus, type ConversationEntry } from "../core";

export interface ConversationsData {
  active: ConversationEntry[];
  /** The newest ended conversations (the `conversations-gone` default window). */
  recentGone: ConversationEntry[];
  totalGoneCount: number;
}

/** The live and recently ended conversations, with the ended total, as one read. */
export function useConversations(): ResourceResult<ConversationsData> {
  const active = useLive(conversationsActive);
  const gone = useLive(conversationsGone);
  const goneCount = useLive(conversationsGone, GONE_COUNT);
  const all = useCombinedResources({ active, gone, goneCount });
  return mapResource(all, (d): ConversationsData => ({
    active: d.active,
    recentGone: d.gone,
    totalGoneCount: d.goneCount,
  }));
}

// Every ended conversation: the collection's whole total (boot-preloaded).
const GONE_COUNT = { count: true } as const;

// Point lookup by id: the `conversations.by-id` point read of this one id, so
// the component re-renders only when THAT conversation changes — and any
// conversation is found, a done one older than the newest gone window
// included (W9: the old three-list slice never found it, and two REST
// fallbacks hid the gap).
//
// A read, not a nullable row: `loading` until the server answers, `error` if
// the read failed (its last-seen row as `stale`), and a ready `null` only when
// no conversation has this id — so "not loaded yet" and "failed" never reach a
// caller as "no such conversation". A `null` id (nothing to look up yet) is a
// ready `null` from the first render.
export function useConversation(
  id: string | null,
): ResourceResult<ConversationEntry | null> {
  const row = useLiveRow(conversationsById, id);
  return useMemo(() => mapRow(row, (r): ConversationEntry | null => r), [row]);
}

/**
 * The live row of a conversation a surface already holds, else that snapshot.
 * For a control handed a conversation by its host: while the read loads, or
 * when it failed (its last-seen row first), it keeps rendering the
 * conversation it was given rather than blanking — the host owns rendering
 * the read's failure.
 */
export function useLiveConversation<T extends { id: string }>(
  snapshot: T,
): ConversationEntry | T {
  const live = useConversation(snapshot.id);
  return foldResource(live, {
    loading: () => snapshot,
    error: (_error, stale) => stale ?? snapshot,
    ready: (row) => row ?? snapshot,
  });
}

// Derived SLICE: does this task have another active conversation? Subscribes
// only to that boolean via `select`, so the component re-renders only when the
// answer flips — not on every push to the active set. Used by drop-and-exit.
//
// Returns the read (NOT a bare boolean): the answer decides a DESTRUCTIVE
// action, so callers must distinguish "loading" from "no sibling" — collapsing
// loading to `false` is exactly the wrong-default-while-loading bug. An `all`
// read with a selector is gated, so the loading→settled flip re-renders.
export function useHasActiveSiblings(
  taskId: string,
  excludeId: string,
): ResourceResult<boolean> {
  const select = useCallback(
    (active: ConversationEntry[]) =>
      active.some((c) => c.taskId === taskId && c.id !== excludeId),
    [taskId, excludeId],
  );
  return useLive(conversationsActive, { select });
}

// Derived SLICE: is there another active conversation in this worktree? Used by
// push-and-exit to decide between Exit and Drop & Exit. A read for the same
// reason as useHasActiveSiblings — the answer picks a destructive default.
export function useHasActiveSiblingInWorktree(
  worktreePath: string,
  excludeId: string,
): ResourceResult<boolean> {
  const select = useCallback(
    (active: ConversationEntry[]) =>
      active.some(
        (c) =>
          c.id !== excludeId &&
          c.worktreePath === worktreePath &&
          isActiveStatus(c.status),
      ),
    [worktreePath, excludeId],
  );
  return useLive(conversationsActive, { select });
}

// The active conversations list. The whole set IS the active list, so this is
// a thin pass-through of the read; callers branch on `.status` (never collapse
// it to a default). Used by the dependencies button's cross-task picker.
export function useActiveConversations(): ResourceResult<ConversationEntry[]> {
  return useLive(conversationsActive);
}

// Point lookup by id, as a row or `null` — for a surface whose contract is
// "the conversation, or nothing to show yet". `null` while the by-id read
// loads, when no conversation has the id, and when the read failed with
// nothing seen (its last-seen row first). Any conversation resolves live,
// however old (W9) — there is no REST fallback, and a close no longer moves
// the row between two lists, so there is no in-transit gap to paper over.
export function useConversationById(
  id: string | null,
): ConversationEntry | null {
  const row = useLiveRow(conversationsById, id);
  switch (row.status) {
    case "loading":
      return null;
    case "error":
      return row.stale ?? null;
    case "ready":
      return row.found ? row.row : null;
  }
}

// A worktree's slug is the basename of its checkout path — the key the op log
// (`opSlug`) and the op markers file a worktree under, and by the basename
// invariant the attempt id. Derived by hand: no node:path in the browser.
function worktreeSlugOf(worktreePath: string): string {
  const parts = worktreePath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? worktreePath;
}

const EMPTY_TITLES: Readonly<Record<string, string>> = {};

// One conversation list as a partial slug → title map.
function titleMapOf(rows: ConversationEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of rows) {
    const title = c.title?.trim();
    if (title) map[worktreeSlugOf(c.worktreePath)] = title;
  }
  return map;
}

/**
 * Worktree slug → the human title of a conversation that ran in it, so a
 * surface listing worktrees (the op-status queue, the Ops Gantt rows) reads as
 * task names rather than attempt ids. A pure client-side lookup over the three
 * conversation lists (the live sets and the gone window) (in the agent-manager, the main-DB set).
 *
 * Cosmetic by design: while a list loads, or if one failed, the map is empty and
 * every label falls back to its slug — the caller's own read renders its own
 * failure. The two live sets are read through a `select` slice, so a status
 * flip in them re-renders the caller only when a mapping actually changes; the
 * gone window's map is derived from its rows.
 */
export function useConversationTitleBySlug(): Readonly<Record<string, string>> {
  const active = useLive(conversationsActive, { select: titleMapOf });
  const system = useLive(conversationsSystem, { select: titleMapOf });
  // A window has no selector: its map is derived here, per window value.
  const goneRows = useLive(conversationsGone);
  const gone = useMemo(() => mapResource(goneRows, titleMapOf), [goneRows]);
  return useMemo(() => {
    if (
      active.status === "ready" &&
      gone.status === "ready" &&
      system.status === "ready"
    )
      // A live `active` title wins over a stale gone / system one.
      return { ...system.data, ...gone.data, ...active.data };
    return EMPTY_TITLES;
  }, [active, gone, system]);
}
