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
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import {
  UserMessageCard,
  UserMessageText,
} from "@plugins/conversations/plugins/conversation-view/plugins/user-message/web";
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

function UserBubble({ text }: { text: string }) {
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
  turn,
  latest,
  renderResult,
  resultWords,
}: {
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
          <Markdown>{turn.answer.text}</Markdown>
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

export interface AgentThreadViewProps<D extends ThreadResultDef> {
  turns: readonly ThreadTurn<D>[];
  state: ThreadState;
  renderResult: RenderThreadResult<D>;
  /** Leading in the header — who the thread is with ("✦ Sonnet"). */
  title?: ReactNode;
  /** How the header counts the newest turn's results; default "N results". */
  resultWords?: ResultWords;
  /** Trailing in the header — the Open conversation link, a host's close. */
  headerAction?: ReactNode;
  /** After the last turn, inside the scroller: a pending question, sent-turn echoes. */
  trailing?: ReactNode;
  /** Pinned under the scroller. */
  composer: ReactNode;
  /** Changing it re-follows the bottom — the user just sent a turn. */
  followKey?: number;
}

/**
 * An agent thread as drawn from its turns — the whole look, with every live
 * part (the composer, a pending question, the echoes) handed in. Fills its
 * container: header, the scrolling turns, the composer.
 */
export function AgentThreadView<D extends ThreadResultDef>({
  turns,
  state,
  renderResult,
  title,
  resultWords = defaultResultWords,
  headerAction,
  trailing,
  composer,
  followKey,
}: AgentThreadViewProps<D>) {
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
    <Column
      className="h-full"
      header={
        <ThreadHeader
          state={state}
          resultCount={resultCount}
          resultWords={resultWords}
          title={title}
          action={headerAction}
        />
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
  );
}
