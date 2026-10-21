import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  mapResource,
  ResourceErrorInline,
  ResourceView,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";

import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import {
  useTranscriptWindow,
  type TranscriptWindow,
} from "../use-transcript-window";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  WorkingDots,
  WorkingText,
} from "@plugins/primitives/plugins/css/plugins/working-dots/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { conversationPartialMessage } from "@plugins/conversations/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { workingActivityOf } from "../working-activity";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ElapsedTime } from "@plugins/primitives/plugins/relative-time/web";
import { ConversationIdProvider } from "./conversation-id-context";
import { TranscriptView } from "./transcript-view";
import {
  usePendingTurns,
  PendingTurnCard,
  type PendingTurn,
  type RenderEcho,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { EchoRow } from "./echo-row";
import { StreamingMessage } from "./streaming-message";
import { standInsOf } from "../streaming-blocks";
import { JsonlViewer } from "../slots";
import type { TranscriptSubject } from "./transcript-subject-context";

const CONVERSATION_SUBJECT: TranscriptSubject = { kind: "conversation" };

/** A sent turn's echo, drawn as the transcript's own prompt row. */
const renderEcho: RenderEcho = (turn, status) => (
  <EchoRow
    turnId={turn.id}
    text={turn.text}
    sentAt={turn.sentAt}
    status={status}
  />
);

/**
 * The transcript's one activity line, at its foot under the queued messages:
 * what the agent is doing — starting, or working on a turn (read from the
 * transcript's tail: writing, the tool it is running, thinking) — with how long
 * it has been at it. A message on its way says so itself, under its echo.
 */
function TranscriptActivity({
  phase,
  startAt,
  conversationId,
  events,
}: {
  phase: "starting" | "working";
  startAt: number | null;
  conversationId: string;
  events: readonly JsonlEvent[];
}) {
  const partial = useLive(conversationPartialMessage, { id: conversationId });
  // Not known yet, unavailable or failed: nothing is being written — the label
  // then reads what the transcript itself says the agent is doing. Otherwise
  // the blocks still being written are the transcript's tail (their stamp is
  // never read here).
  const standIns =
    partial.status === "ready" && partial.data
      ? standInsOf(partial.data, events, "").map((s) => s.event)
      : [];
  const writing = standIns.at(-1)?.kind === "assistant-text";
  const working = workingActivityOf([...events, ...standIns], writing);
  return (
    // px-md: the same inset as the transcript's text rows, so the dots start
    // on the column the agent's words and the tool cards' contents start on.
    <Stack direction="row" align="center" gap="sm" className="px-md py-xs">
      <WorkingDots mood={phase === "working" ? working.mood : "working"} />
      <Line>
        <Text as="span" variant="caption">
          <WorkingText>
            {phase === "starting" ? "Starting the agent" : working.label}
          </WorkingText>
        </Text>
      </Line>
      {startAt != null && (
        <Text
          as="span"
          variant="caption"
          className="tabular-nums text-muted-foreground/60"
        >
          <ElapsedTime since={new Date(startAt)} />
        </Text>
      )}
    </Stack>
  );
}

/**
 * A conversation with nothing in it yet: one quiet line centred in the pane,
 * a little above the middle, with the composer below as the only control. A
 * conversation that ended without a transcript says so instead of inviting a
 * first message.
 */
function BlankTranscript({ ended }: { ended: boolean }) {
  return (
    <Center className={`${growClass()} pb-2xl`}>
      <Stack gap="xs" align="center">
        <Text as="div" variant="label" tone="muted">
          {ended ? "No transcript" : "Nothing here yet"}
        </Text>
        {!ended && (
          <Text as="div" variant="caption" tone="faint">
            The first message starts the agent.
          </Text>
        )}
      </Stack>
    </Center>
  );
}

/**
 * The agent is up but has not written its first line: the working indicator,
 * where the blank hint was, instead of alone in the pane's top corner.
 */
function StartingTranscript({ startAt }: { startAt: number | null }) {
  return (
    <Center className={`${growClass()} pb-2xl`}>
      <Stack gap="sm" align="center">
        <WorkingDots />
        <Text as="div" variant="label" tone="muted">
          Starting the agent
        </Text>
        {startAt != null && (
          <Text
            as="div"
            variant="caption"
            tone="faint"
            className="tabular-nums"
          >
            <ElapsedTime since={new Date(startAt)} />
          </Text>
        )}
      </Stack>
    </Center>
  );
}

function JsonlPaneInner({
  conversation,
  window,
  pending,
}: {
  conversation: Conversation;
  /** The transcript's latest events; older ones load on scroll. */
  window: TranscriptWindow;
  /** The turn ledger's cards — answered (ready, or failed); see JsonlPane. */
  pending: Exclude<ResourceResult<PendingTurn[]>, { status: "loading" }>;
}) {
  const isWorking =
    conversation.status === "working" || conversation.status === "starting";
  const isGone =
    conversation.status === "gone" || conversation.status === "done";
  const { events } = window;

  // The turn ledger's cards (echo, merged warning, Retry), shown while working
  // too — that is exactly when messages queue. A ledger read that failed shows
  // its error where the cards go, over the cards it last held.
  const pendingTurns =
    pending.status === "ready" ? pending.data : (pending.stale ?? []);

  // Derive when "working" started: last event's timestamp, or now if none.
  // Seeded once per working transition (snapshot of the last event present at
  // the rising edge), kept out of render so we never read the clock during render.
  const [workingStartAt, setWorkingStartAt] = useState<number | null>(null);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- rising-edge snapshot: fires only on the isWorking transition (dep array is intentionally [isWorking]) to freeze workingStartAt once at transition time; a render-derived value can't capture the clock once per edge without re-snapshotting on every new event. */
    if (isWorking) {
      if (workingStartAt == null) {
        const last = events.length ? events[events.length - 1] : null;
        const lastAt = last?.at ?? null;
        setWorkingStartAt(lastAt ? new Date(lastAt).getTime() : Date.now());
      }
    } else {
      setWorkingStartAt(null);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot events once per working transition
  }, [isWorking]);

  const agentStarting = conversation.status === "starting";
  // The foot's activity line (see TranscriptActivity): the agent's phase. A
  // message still on its way to an idle agent says so under its own echo.
  const activity: "starting" | "working" | null = agentStarting
    ? "starting"
    : isWorking
      ? "working"
      : null;

  // Working with nothing written yet: the pane's empty state shows it.
  const isStarting =
    isWorking &&
    events.length === 0 &&
    pendingTurns.length === 0 &&
    pending.status === "ready" &&
    !conversation.waitingFor;

  return (
    <TranscriptView
      events={events}
      ids={window.ids}
      firstSeq={window.firstSeq}
      older={window.older}
      conversationId={conversation.id}
      subject={CONVERSATION_SUBJECT}
      // The surface tab is appended by the view — name only the subject here.
      persistKey={`conversation-scroll:${conversation.id}`}
      // The user sending a turn, NOT `isWorking`. A rising `isWorking` also
      // fires when a background agent resumes on its own, which must not yank a
      // reading user to the bottom.
      followKey={pendingTurns.length}
      dimmed={isGone}
      // A queued turn or a pending prompt already fills the empty pane; with
      // neither, it holds the starting indicator or the blank hint, centred.
      empty={
        pendingTurns.length > 0 ||
        pending.status === "error" ||
        !!conversation.waitingFor ? null : isStarting ? (
          <StartingTranscript startAt={workingStartAt} />
        ) : (
          <BlankTranscript ended={isGone} />
        )
      }
      // The readings pinned at the foot of the pane (context/output usage, the
      // token budget, …) are Overlay contributions — see the
      // `transcript-stats` sub-plugin, which owns the strip AND the reading
      // position it reports as of. A surface opts in by handing them to the
      // view (a sub-agent's pane does too); each folds over the transcript the
      // view draws via `useTranscriptEvents()`.
      overlay={<JsonlViewer.Overlay.Render />}
    >
      <StreamingMessage conversationId={conversation.id} />
      <JsonlViewer.TranscriptEnd.Render>
        {(item) => <item.component conversation={conversation} />}
      </JsonlViewer.TranscriptEnd.Render>
      {!isWorking && !!conversation.waitingFor && (
        <JsonlViewer.PendingPrompt.Dispatch
          conversationId={conversation.id}
          waitingFor={conversation.waitingFor}
        />
      )}
      {pendingTurns.map((turn) => (
        <PendingTurnCard
          key={turn.id}
          conversationId={conversation.id}
          turn={turn}
          agentStarting={agentStarting}
          renderEcho={renderEcho}
        />
      ))}
      {activity !== null && !isStarting && (
        <TranscriptActivity
          phase={activity}
          startAt={workingStartAt}
          conversationId={conversation.id}
          events={events}
        />
      )}
      {pending.status === "error" && (
        <ResourceErrorInline
          variant="inline"
          subject="the sent messages"
          error={pending.error}
          refetch={pending.refetch}
        />
      )}
    </TranscriptView>
  );
}

export function JsonlPane({
  conversation,
  children,
}: {
  conversation: Conversation;
  children?: ReactNode;
}) {
  const windowResult = useTranscriptWindow(conversation.id);
  // The pending cards are read against the transcript this pane renders: an
  // echo stands until the transcript reaches its turn's confirmation — read
  // from the newest event, which the tail window always holds.
  const eventsResult = useMemo(
    () => mapResource(windowResult, (w) => w.events),
    [windowResult],
  );
  const pending = usePendingTurns(conversation.id, eventsResult);

  return (
    // Declared out here as well as inside `TranscriptView`, and it is not a
    // duplicate: this one says "the whole pane is about this conversation", so
    // the composer below and the loading/error branches — which render no
    // transcript at all — can still answer the question. The view declares it
    // again for the rows it draws, which is what makes a transcript surface
    // that is NOT a conversation pane (a sub-agent's own) still able to say
    // which conversation its rows came from.
    <ConversationIdProvider id={conversation.id}>
      <Stack gap="none" className="h-full min-h-0">
        <ResourceView
          // Loading until the turn ledger has answered too: the cards it draws
          // decide whether the pane is empty, starting or neither. Its failure
          // does not hide the transcript — the inner pane shows it inline.
          resource={pending.status === "loading" ? pending : windowResult}
          fallback={
            // eslint-disable-next-line layout/no-adhoc-layout -- relative+isolate positioning host that is also the flex-fill child of the transcript column (mirrors TranscriptView)
            <div className="relative min-h-0 flex-1 isolate">
              <Scroll axis="both" data-pane-scroll className="h-full">
                <Loading className="px-md py-sm" />
              </Scroll>
            </div>
          }
          errorFallback={(err) => (
            // eslint-disable-next-line layout/no-adhoc-layout -- relative+isolate positioning host that is also the flex-fill child of the transcript column (mirrors TranscriptView)
            <div className="relative min-h-0 flex-1 isolate">
              <Scroll axis="both" data-pane-scroll className="h-full">
                <Text
                  as="div"
                  variant="caption"
                  className="px-md py-sm text-destructive"
                >
                  {err.message}
                </Text>
              </Scroll>
            </div>
          )}
        >
          {(window) =>
            pending.status === "loading" ? null : (
              <JsonlPaneInner
                conversation={conversation}
                window={window}
                pending={pending}
              />
            )
          }
        </ResourceView>
        {children}
      </Stack>
    </ConversationIdProvider>
  );
}
