import { useMemo } from "react";
import {
  foldResource,
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JSONL_EVENTS_MAX } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import {
  useTranscriptWindow,
  useVisibleEvents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { useOptimisticConversationStatus } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useConversation } from "@plugins/conversations/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import {
  groupThread,
  latestResultOf,
  threadProgressOf,
  type ThreadProgress,
  type ThreadResultDef,
  type ThreadTurn,
} from "../../core";

const NO_EVENTS: JsonlEvent[] = [];

/**
 * A transcript read, as the transcript renders it (`useVisibleEvents`: the
 * events no `JsonlViewer.EventFilter` hides). The filter hook runs on every
 * render whatever the read's state; its output reaches only the ready arm (and
 * an error arm's `stale`), so an unloaded transcript never reads as empty.
 */
export function useVisibleTranscript(
  events: ResourceResult<JsonlEvent[]>,
): ResourceResult<readonly JsonlEvent[]> {
  const raw = foldResource(events, {
    loading: () => NO_EVENTS,
    error: (_error, stale) => stale ?? NO_EVENTS,
    ready: (data) => data,
  });
  const visible = useVisibleEvents(raw);
  return useMemo(() => mapResource(events, () => visible), [events, visible]);
}

/**
 * A thread's transcript: the conversation whole (up to `jsonlEvents`' ceiling,
 * in one page — a thread is drawn whole and cannot scroll back), kept live by
 * keyed deltas.
 */
export function useThreadTranscript(
  conversationId: string,
): ResourceResult<JsonlEvent[]> {
  const window = useTranscriptWindow(conversationId, {
    limit: JSONL_EVENTS_MAX,
  });
  return useMemo(() => mapResource(window, (w) => w.events), [window]);
}

/**
 * The result kinds a caller passed, stable across renders that pass a new
 * array of the same kinds (`results={[picks]}` written inline).
 */
function useStableResults<D extends ThreadResultDef>(
  results: readonly D[],
): readonly D[] {
  const key = results.map((d) => d.tool).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the kinds' tools: a new array of the same kinds is the same list
  return useMemo(() => results, [key]);
}

// The status hook needs a conversation before the row has loaded; whatever it
// answers then is discarded (only a ready row's status reaches a caller).
const NOT_LOADED = {
  status: "gone" as ConversationStatus,
  updatedAt: new Date(0),
};

/** One thread read: its conversation row, status as the user sees it, and turns. */
export interface ThreadSnapshot<D extends ThreadResultDef> {
  conversation: ConversationEntry;
  /** The row's status, `working` from the instant a turn is sent. */
  status: ConversationStatus;
  turns: ThreadTurn<D>[];
}

/**
 * The thread of conversation `conversationId`: loading until both its row and
 * its transcript are in, a ready `null` when no such conversation exists.
 */
export function useThread<D extends ThreadResultDef>(
  conversationId: string,
  results: readonly D[],
): ResourceResult<ThreadSnapshot<D> | null> {
  const events = useVisibleTranscript(useThreadTranscript(conversationId));
  const row = useConversation(conversationId);
  const loadedRow = foldResource(row, {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (data) => data,
  });
  const status = useOptimisticConversationStatus({
    id: conversationId,
    ...(loadedRow ?? NOT_LOADED),
  });
  const defs = useStableResults(results);
  const both = useCombinedResources({ events, row });
  return useMemo(
    () =>
      mapResource(both, ({ events: visible, row: conversation }) =>
        conversation === null
          ? null
          : {
              conversation,
              status,
              turns: groupThread(visible, defs, {
                status,
                waitingFor: conversation.waitingFor,
              }),
            },
      ),
    [both, status, defs],
  );
}

/** The thread's turns — see `groupThread`. A ready `null`: no such conversation. */
export function useThreadTurns<D extends ThreadResultDef>(
  conversationId: string,
  results: readonly D[],
): ResourceResult<ThreadTurn<D>[] | null> {
  const thread = useThread(conversationId, results);
  return useMemo(
    () => mapResource(thread, (t) => (t === null ? null : t.turns)),
    [thread],
  );
}

/**
 * How the thread is going, for a host's surface beside it (a progress pill):
 * its state, the newest turn's steps and results, and whether it said
 * something since the user last looked. `results` are the kinds the host
 * renders, so their calls count as results rather than steps.
 */
export function useThreadProgress<D extends ThreadResultDef>(
  conversationId: string,
  results: readonly D[],
): ResourceResult<ThreadProgress | null> {
  const thread = useThread(conversationId, results);
  return useMemo(
    () =>
      mapResource(thread, (t) =>
        t === null
          ? null
          : threadProgressOf(t.turns, {
              status: t.status,
              waitingFor: t.conversation.waitingFor,
              lastViewedAt: t.conversation.lastViewedAt,
            }),
      ),
    [thread],
  );
}

/**
 * The newest accepted result of kind `def` across the whole thread — a ready
 * `null` until the agent delivered one (or when no such conversation exists).
 */
export function useLatestResult<T>(
  conversationId: string,
  def: ThreadResultDef<T>,
): ResourceResult<{ payload: T; at: string } | null> {
  const results = useMemo(() => [def], [def]);
  const thread = useThread(conversationId, results);
  return useMemo(
    () =>
      mapResource(thread, (t) =>
        t === null ? null : latestResultOf(t.turns, def),
      ),
    [thread, def],
  );
}
