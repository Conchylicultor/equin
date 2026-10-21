import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ResourceErrorInline,
  ResourceView,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import {
  PendingTurnCard,
  useOptimisticConversationStatus,
  useTurnRunning,
  usePendingTurns,
  type PendingTurn,
  type RenderEcho,
} from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { useMarkConversationViewed } from "@plugins/conversations/plugins/hibernation/web";
import { useConversation } from "@plugins/conversations/web";
import type { ConversationEntry } from "@plugins/conversations/core";
import {
  groupThread,
  latestOutputAt,
  threadStateOf,
  type ThreadResultDef,
} from "../../core";
import {
  useThreadTranscript,
  useVisibleTranscript,
} from "../internal/use-thread";
import {
  AgentThreadView,
  UserBubble,
  type RenderThreadResult,
  type ResultWords,
} from "./agent-thread-view";
import { ThreadComposer } from "./composer";

export interface AgentThreadProps<D extends ThreadResultDef> {
  conversationId: string;
  /** The result kinds this host renders; their accepted calls are results, not steps. */
  results: readonly D[];
  renderResult: RenderThreadResult<D>;
  /** The composer's placeholder. */
  placeholder?: string;
  /** Leading in the header — who the thread is with ("✦ Sonnet"). */
  title?: ReactNode;
  /** How the header counts the newest turn's results ("3 picks"); default "3 results". */
  resultWords?: ResultWords;
  /** In the header after Open conversation — the host's own control (a close). */
  headerAction?: ReactNode;
}

/** A sent turn's echo: the thread's own user bubble, its status under it. */
const renderEcho: RenderEcho = (turn, status) => (
  <Stack gap="sm">
    <UserBubble text={turn.text} />
    <Stack gap="none" align="end">
      {status}
    </Stack>
  </Stack>
);

/** Open the full conversation in the Agent Manager (it crosses apps by itself). */
function OpenConversation({ conversationId }: { conversationId: string }) {
  const openPane = useOpenPane();
  return (
    <Button
      variant="ghost"
      {...openPane.link(
        conversationPane,
        { convId: conversationId },
        { mode: "push" },
      )}
    >
      Open conversation
    </Button>
  );
}

/**
 * The user has seen what the thread said: stamp the conversation viewed while
 * this thread is on screen and has something newer than the last view. Only
 * then, because marking viewed also resumes a hibernated conversation — a
 * thread restored with nothing new to show must not wake its agent.
 *
 * On screen is the thread's own box intersecting the viewport (`onScreen`) in
 * a visible page — not merely mounted: a host may keep the thread mounted
 * while it hides it (a closed popover), and a hidden answer is not a seen one.
 */
function useMarkViewedWhileVisible(
  conversation: ConversationEntry,
  outputAt: number | null,
  onScreen: boolean,
): void {
  const markViewed = useMarkConversationViewed();
  const viewedAt = conversation.lastViewedAt?.getTime() ?? null;
  const unseen =
    outputAt !== null && (viewedAt === null || outputAt > viewedAt);
  const id = conversation.id;
  const hibernatedAt = conversation.hibernatedAt;
  useEffect(() => {
    if (!unseen || !onScreen) return;
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      void markViewed({ id, hibernatedAt });
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [unseen, onScreen, id, hibernatedAt, markViewed]);
}

function LiveThread<D extends ThreadResultDef>({
  conversation,
  events,
  pending,
  results,
  renderResult,
  placeholder,
  header,
}: {
  conversation: ConversationEntry;
  events: readonly JsonlEvent[];
  /** The turn ledger's cards — answered (ready, or failed). */
  pending: AnsweredPending;
  results: readonly D[];
  renderResult: RenderThreadResult<D>;
  placeholder: string;
  header: ThreadHeaderParts;
}) {
  const status = useOptimisticConversationStatus(conversation);
  const turnRunning = useTurnRunning(conversation);
  const waitingFor = conversation.waitingFor;
  const key = results.map((d) => d.tool).join("\n");
  const turns = useMemo(
    () => groupThread(events, results, { status, waitingFor }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the kinds' tools: an inline `results={[…]}` is the same list every render
    [events, key, status, waitingFor],
  );
  const state = threadStateOf(turns, { status, waitingFor });
  // A ledger read that failed shows its error where the cards go, over the
  // cards it last held.
  const pendingTurns =
    pending.status === "ready" ? pending.data : (pending.stale ?? []);
  const boxRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  useInView(boxRef, (entry) => setOnScreen(entry.isIntersecting));
  useMarkViewedWhileVisible(conversation, latestOutputAt(turns), onScreen);

  return (
    // The box whose intersection says the thread is on screen.
    <div ref={boxRef} className="h-full">
    <AgentThreadView
      turns={turns}
      state={state}
      renderResult={renderResult}
        title={header.title}
        {...(header.resultWords === undefined
          ? {}
          : { resultWords: header.resultWords })}
        headerAction={
          <>
            <OpenConversation conversationId={conversation.id} />
            {header.headerAction}
          </>
        }
      followKey={pendingTurns.length}
      trailing={
        <>
          {status !== "working" && waitingFor !== null && (
            <JsonlViewer.PendingPrompt.Dispatch
              conversationId={conversation.id}
              waitingFor={waitingFor}
            />
          )}
          {pendingTurns.map((turn) => (
            <PendingTurnCard
              key={turn.id}
              conversationId={conversation.id}
              turn={turn}
              agentStarting={status === "starting"}
              renderEcho={renderEcho}
            />
          ))}
          {pending.status === "error" && (
            <ResourceErrorInline
              variant="inline"
              subject="the sent messages"
              error={pending.error}
              refetch={pending.refetch}
            />
          )}
        </>
      }
      composer={
        <ThreadComposer
          conversation={conversation}
          status={status}
          turnRunning={turnRunning}
          placeholder={placeholder}
        />
      }
    />
    </div>
  );
}

/** The host's parts of the thread's header. */
interface ThreadHeaderParts {
  title: ReactNode;
  resultWords: ResultWords | undefined;
  headerAction: ReactNode;
}

type AnsweredPending = Exclude<
  ResourceResult<PendingTurn[]>,
  { status: "loading" }
>;

function Fallback({ children }: { children: ReactNode }) {
  return <Center className="h-full p-md">{children}</Center>;
}

function Missing() {
  return (
    <Fallback>
      <Text variant="caption" tone="muted">
        This conversation no longer exists.
      </Text>
    </Fallback>
  );
}

/**
 * A conversation shown as a thread inside a host's own surface: the user's
 * turns as bubbles, the agent's tool calls condensed into a live step list,
 * its answer, and the host's own cards for the results it delivered
 * (`renderResult`), then a composer to reply. Fills its container; the host
 * owns the frame around it.
 *
 * Read live from the transcript, so it and the Agent Manager never disagree;
 * the conversation keeps running whether or not this is mounted.
 */
export function AgentThread<D extends ThreadResultDef>({
  conversationId,
  results,
  renderResult,
  placeholder = "Reply…",
  title,
  resultWords,
  headerAction,
}: AgentThreadProps<D>) {
  const raw = useThreadTranscript(conversationId);
  const events = useVisibleTranscript(raw);
  const row = useConversation(conversationId);
  // The echoes stand until the transcript holds their turn.
  const pending = usePendingTurns(conversationId, raw);
  const both = useCombinedResources({ events, row });

  const loading = (
    <Fallback>
      <Loading />
    </Fallback>
  );
  // Loading until the turn ledger has answered too: its cards decide what the
  // thread ends with. Its failure does not hide the thread — it shows inline.
  if (pending.status === "loading") return loading;
  return (
    <ResourceView
      resource={both}
      fallback={loading}
      errorFallback={(err) => (
        <Fallback>
          <ResourceErrorInline
            variant="block"
            error={err}
            refetch={both.refetch}
          />
        </Fallback>
      )}
    >
      {({ events: visible, row: conversation }) =>
        conversation === null ? (
          <Missing />
        ) : (
          <LiveThread
            conversation={conversation}
            events={visible}
            pending={pending}
            results={results}
            renderResult={renderResult}
            placeholder={placeholder}
            header={{ title, resultWords, headerAction }}
          />
        )
      }
    </ResourceView>
  );
}
