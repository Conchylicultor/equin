import { Fragment, useCallback, type ReactNode } from "react";
import {
  JumpToBottomButton,
  useStickyScroll,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import {
  StatusDot,
  type StatusDotPaint,
} from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { ActiveDataMarkdown } from "@plugins/active-data/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
import { PromptComposerProvider } from "@plugins/conversations/plugins/conversation-view/web";
import type {
  AcceptedThreadResult,
  ThreadResult,
  ThreadResultDef,
  ThreadState,
  ThreadTurn,
} from "../../core";
import { resultCountOf } from "../../core";
import { StepList } from "./step-list";
import { defaultResultWords, type ResultWords } from "./result-words";

export type { ResultWords } from "./result-words";

/** How a host draws one accepted result; `latest` is true in the newest turn. */
export type RenderThreadResult<D extends ThreadResultDef> = (
  result: AcceptedThreadResult<D>,
  ctx: { latest: boolean },
) => ReactNode;

/** What a host-drawn header reads: where the thread stands, and whose it is. */
export interface ThreadHeaderContext {
  conversationId: string;
  state: ThreadState;
  /** The newest turn's delivered results (as `resultWords` counts them). */
  resultCount: number;
}

/** A host's own header for the thread, drawn in place of the default one. */
export type RenderThreadHeader = (ctx: ThreadHeaderContext) => ReactNode;

/**
 * Who draws the thread's header. Either the default — the status (dot and
 * words) between the host's `title` and `headerAction` — or the host's own
 * `header`, which then owns the whole row (a floating card whose header is
 * its drag handle). Exclusive: a `header` takes no `title` or `headerAction`.
 */
export type ThreadHeaderOptions =
  | {
      header?: undefined;
      /** Leading in the header — who the thread is with ("✦ Sonnet"). */
      title?: ReactNode;
      /** Trailing in the header — the host's own control (a close). */
      headerAction?: ReactNode;
    }
  | { header: RenderThreadHeader; title?: never; headerAction?: never };

const STATE_DOT: Record<ThreadState, StatusDotPaint> = {
  working: { colorClass: "bg-primary animate-pulse" },
  waiting: { colorClass: "bg-warning" },
  done: { colorClass: "bg-success" },
  failed: { colorClass: "bg-destructive" },
};

function stateWords(
  state: ThreadState,
  resultCount: number,
  resultWords: ResultWords,
): string {
  switch (state) {
    case "working":
      return "Working…";
    case "waiting":
      return "Waiting for you";
    case "failed":
      return "Failed";
    case "done":
      return resultCount === 0 ? "Done" : resultWords(resultCount);
  }
}

function ThreadHeader({
  state,
  resultCount,
  resultWords,
  title,
  action,
}: {
  state: ThreadState;
  resultCount: number;
  resultWords: ResultWords;
  title?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Line className="gap-sm border-b border-border px-md py-xs">
      {title}
      <StatusDot {...STATE_DOT[state]} />
      <Fill>
        <Text
          variant="label"
          tone={state === "failed" ? "destructive" : "default"}
        >
          {stateWords(state, resultCount, resultWords)}
        </Text>
      </Fill>
      {action}
    </Line>
  );
}

/** The user's message in a thread — also a sent turn's echo, so the two match. */
export function UserBubble({ text }: { text: string }) {
  return (
    <Stack gap="none" align="end">
      <div className="max-w-[85%]">
        <UserMessageCard>
          <UserMessageText text={text} />
        </UserMessageCard>
      </div>
    </Stack>
  );
}

function InvalidResult({ result }: { result: ThreadResult }) {
  return (
    <Text as="div" variant="caption" tone="destructive">
      A {result.def.tool} result could not be read.
    </Text>
  );
}

function TurnView<D extends ThreadResultDef>({
  conversationId,
  turn,
  latest,
  renderResult,
  resultWords,
}: {
  conversationId: string;
  turn: ThreadTurn<D>;
  latest: boolean;
  renderResult: RenderThreadResult<D>;
  resultWords: ResultWords;
}) {
  // The agent is between tools (thinking, writing): say it is still on it.
  const thinking =
    turn.state === "running" && !turn.steps.some((s) => s.state === "running");
  return (
    <Stack gap="sm">
      <UserBubble text={turn.user.text} />
      <StepList turn={turn} resultWords={resultWords} />
      {thinking && <BouncingDots />}
      {turn.answer && (
        <Text as="div" variant="body">
          <ActiveDataMarkdown
            text={turn.answer.text}
            conversationId={conversationId}
            messageId={turn.answer.messageId}
          />
        </Text>
      )}
      {turn.results.map((result) => (
        <Fragment key={result.toolUseId}>
          {result.kind === "accepted" ? (
            renderResult(result as AcceptedThreadResult<D>, { latest })
          ) : (
            <InvalidResult result={result} />
          )}
        </Fragment>
      ))}
      {turn.state === "failed" && (
        <Text as="div" variant="caption" tone="destructive">
          The agent stopped without an answer — open the conversation to see
          what happened.
        </Text>
      )}
    </Stack>
  );
}

export type AgentThreadViewProps<D extends ThreadResultDef> =
  AgentThreadViewBaseProps<D> & ThreadHeaderOptions;

interface AgentThreadViewBaseProps<D extends ThreadResultDef> {
  /** The conversation the turns are folded from — the identity of their answers' active-data blocks. */
  conversationId: string;
  turns: readonly ThreadTurn<D>[];
  state: ThreadState;
  renderResult: RenderThreadResult<D>;
  /** How the header and the step lists count results; default "N results". */
  resultWords?: ResultWords;
  /** After the last turn, inside the scroller: a pending question, sent-turn echoes. */
  trailing?: ReactNode;
  /**
   * Pinned under the scroller. The thread's prompt: one that registers itself
   * (`useRegisterPromptComposer`, as `ThreadComposer` does) is what an answer's
   * `<go>` choices send through and insert into.
   */
  composer: ReactNode;
  /** Changing it re-follows the bottom — the user just sent a turn. */
  followKey?: number;
  /**
   * How tall the thread is: `fill` (default) fills its container; `hug` sizes
   * to its content up to its PARENT element's max-height (inherited — the
   * host's frame sets a `max-h-*`), past which the turns scroll between the
   * header and the composer. For a floating card that grows with its thread.
   */
  height?: ThreadHeight;
}

/** See `AgentThreadViewBaseProps.height`. */
export type ThreadHeight = "fill" | "hug";

/**
 * An agent thread as drawn from its turns — the whole look, with every live
 * part (the composer, a pending question, the echoes) handed in. Fills its
 * container (or hugs it, `height="hug"`): header, the scrolling turns, the
 * composer.
 */
export function AgentThreadView<D extends ThreadResultDef>(
  props: AgentThreadViewProps<D>,
) {
  const {
    conversationId,
    turns,
    state,
    renderResult,
    resultWords = defaultResultWords,
    trailing,
    composer,
    followKey,
    height = "fill",
  } = props;
  const headerOptions: ThreadHeaderOptions = props;
  const { scrollRef, bottomSentinel, isFollowing, jumpToBottom } =
    useStickyScroll({ followKey });
  const attachScroll = useCallback(
    (node: HTMLElement | null) => {
      scrollRef.current = node as HTMLDivElement | null;
    },
    [scrollRef],
  );
  const last = turns.at(-1);
  const resultCount = resultCountOf(last?.results ?? []);

  return (
    // The answers above and the composer below share one prompt.
    <PromptComposerProvider>
      <Column
        {...(height === "hug"
          ? { fit: true, className: "max-h-[inherit]" }
          : { className: "h-full" })}
        header={
          headerOptions.header === undefined ? (
            <ThreadHeader
              state={state}
              resultCount={resultCount}
              resultWords={resultWords}
              title={headerOptions.title}
              action={headerOptions.headerAction}
            />
          ) : (
            headerOptions.header({ conversationId, state, resultCount })
          )
        }
        scrollBody={false}
        body={
          // The positioning host for the jump-to-bottom pin.
          <div className="relative h-full min-h-0">
            <Scroll axis="y" ref={attachScroll} className="h-full">
              <Stack gap="lg" className="min-h-full p-md">
                {turns.length === 0 && trailing == null ? (
                  <Center className={growClass()}>
                    {state === "working" ? (
                      <BouncingDots />
                    ) : (
                      <Text variant="caption" tone="muted">
                        {state === "failed"
                          ? "The agent ended before it started."
                          : "Nothing here yet."}
                      </Text>
                    )}
                  </Center>
                ) : (
                  turns.map((turn, i) => (
                    <TurnView
                      conversationId={conversationId}
                      key={`${turn.user.at}:${i}`}
                      turn={turn}
                      latest={i === turns.length - 1}
                      renderResult={renderResult}
                      resultWords={resultWords}
                    />
                  ))
                )}
                {trailing}
              </Stack>
              {bottomSentinel}
            </Scroll>
            <JumpToBottomButton
              handle={{ isFollowing, jumpToBottom }}
              // eslint-disable-next-line layout/no-adhoc-layout -- corner pin on an external Button (self-renders null when hidden), as in TranscriptView
              className="absolute bottom-2 right-2 z-nav"
            />
          </div>
        }
        footer={composer}
      />
    </PromptComposerProvider>
  );
}
