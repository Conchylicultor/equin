import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  AgentThread,
  EndThreadButton,
  OpenConversationButton,
} from "@plugins/conversations/plugins/agent-thread/web";
import { FileLinksWorkspaceProvider } from "@plugins/primitives/plugins/file-links/web";
import { pickSuggestions } from "../../core";
import { minimizeAsk, releaseRun } from "../internal/ask-store";
import { askQuestionDraft } from "../internal/stores";
import {
  ASK_RESULTS,
  useAskPrepareTurn,
  useAskQuestion,
} from "../internal/use-ask";
import { useRunQuestion } from "../internal/use-question";
import { FiledTaskCard } from "./filed-task-card";
import { AgentInstructionsButton } from "./instructions-button";

const askIcon = symbol("forum");
const minimizeIcon = symbol("remove");
const closeIcon = symbol("close");
const newIcon = symbol("edit-square");
const sendIcon = symbol("arrow-upward");
const suggestionIcon = symbol("arrow-forward");

type DragHandle = (e: PointerEvent<HTMLElement>) => void;

/**
 * The card's frame, the one surface every state of Ask equin is drawn in:
 * the card (the chrome's popover material, a fixed width, and a max height
 * its content hugs up to — it grows with its thread, then the thread scrolls
 * between the header and the composer) or, minimized, the pill. One surface
 * for both, so minimizing and restoring morph it (`Surface`'s size motion)
 * rather than swap one box for another. The card's one child takes the
 * max-height on (`max-h-[inherit]`): AgentThread's `height="hug"`, or the
 * empty card's fit `Column`.
 */
export function CardFrame({
  pill,
  children,
}: {
  /** Minimized: the frame is the pill around `AskPill`. */
  pill: boolean;
  children: ReactNode;
}) {
  return (
    <Surface
      level="overlay"
      {...(pill ? {} : { role: "dialog", "aria-label": "Ask equin" })}
      className={cn(
        pill
          ? "max-w-80 rounded-full"
          : "w-[24rem] max-w-[calc(100vw-1.5rem)] max-h-[min(37.5rem,calc(100vh-6rem))]",
        clipClasses({ axis: "both", fill: false }),
      )}
    >
      {children}
    </Surface>
  );
}

/**
 * The card's one header row — the mark, the title, then the card's actions —
 * and, the whole row, its drag handle: a press on an action is still a click
 * (`useDragGesture` starts a drag on a control only past its threshold).
 */
function CardHeader({
  drag,
  title,
  children,
}: {
  drag: DragHandle;
  title: string;
  /** The actions, trailing. */
  children: ReactNode;
}) {
  return (
    <Line
      onPointerDown={drag}
      className="cursor-grab gap-xs touch-none select-none border-b border-border py-xs pl-md pr-xs text-foreground"
    >
      <Icon icon={askIcon} className="size-4 text-primary-text" />
      <Fill>
        <Text variant="label" tone="strong">
          {title}
        </Text>
      </Fill>
      {children}
    </Line>
  );
}

/**
 * The card's content holding a run (drawn in the host's `CardFrame`): the thread, its header actions, the reply box. A
 * reply sent from another page carries it (`useAskPrepareTurn`); `card` is
 * the card's own element, left out of that page's outline.
 */
export function AskThreadCard({
  conversationId,
  drag,
  card,
}: {
  conversationId: string;
  drag: DragHandle;
  card: () => Element;
}) {
  const question = useRunQuestion(conversationId) ?? "Ask equin";
  const prepareTurn = useAskPrepareTurn(conversationId, card);
  return (
    <>
      {/* The help agent reads the main checkout, so the paths it names are
          main's — and the card sits outside every pane, so nothing else
          would say which workspace they belong to. */}
      <FileLinksWorkspaceProvider workspace="main">
        <AgentThread
          conversationId={conversationId}
          results={ASK_RESULTS}
          height="hug"
          prepareTurn={prepareTurn}
          resultWords={(n) => `${n} task${n === 1 ? "" : "s"} filed`}
          header={() => (
            <CardHeader drag={drag} title={question}>
              <OpenConversationButton
                conversationId={conversationId}
                display="icon"
              />
              <IconButton
                icon={newIcon}
                label="New question"
                onClick={() => releaseRun({ close: false })}
              />
              <AgentInstructionsButton />
              <IconButton
                icon={minimizeIcon}
                label="Minimize"
                onClick={minimizeAsk}
              />
              <EndThreadButton
                conversationId={conversationId}
                onEnded={() => releaseRun({ close: true })}
              />
            </CardHeader>
          )}
          placeholder="Reply…"
          renderResult={(result) => (
            <FiledTaskCard
              taskId={result.output.taskId}
              title={result.payload.title}
            />
          )}
        />
      </FileLinksWorkspaceProvider>
    </>
  );
}

/**
 * The empty card's content (drawn in the host's `CardFrame`): a few suggested questions and the first-question box.
 * Asking starts the run (with where the user is) and the card shows it.
 * `card` is the card's own element, left out of the page outline.
 */
export function AskEmptyCard({
  drag,
  card,
}: {
  drag: DragHandle;
  card: () => Element;
}) {
  const [suggestions] = useState(() => pickSuggestions(Math.random));
  const [draft, setDraft, clearDraft] = useDraft(askQuestionDraft, "");
  const [pending, setPending] = useState(false);
  const { ask, blocked } = useAskQuestion();
  const busy = useRef(false);

  const send = async (question: string, fromDraft: boolean) => {
    if (question.trim() === "" || blocked !== null || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const started = await ask(question, card());
      if (started && fromDraft) clearDraft();
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <Column
      fit
      className="max-h-[inherit]"
      header={
        <CardHeader drag={drag} title="Ask equin">
          <AgentInstructionsButton />
          <IconButton icon={closeIcon} label="Close" onClick={minimizeAsk} />
        </CardHeader>
      }
      body={
        <Stack gap="2xs" className="p-sm">
          {suggestions.map((q) => (
            <Line
              key={q}
              as="button"
              type="button"
              disabled={pending || blocked !== null}
              onClick={() => void send(q, false)}
              className="w-full gap-xs rounded-md px-sm py-xs text-left text-muted-foreground hover:bg-hover-fill hover:text-foreground disabled:opacity-50"
            >
              <Icon icon={suggestionIcon} className="size-4" />
              <Fill>
                <Text variant="body">{q}</Text>
              </Fill>
            </Line>
          ))}
        </Stack>
      }
      footer={
        <Stack
          direction="row"
          gap="xs"
          align="end"
          className="border-t border-border p-sm"
        >
          <Fill>
            <TextEditor
              value={draft}
              onChange={setDraft}
              onSubmit={() => void send(draft, true)}
              submitMode="enter"
              placeholder={blocked ?? "How do I…?"}
              disabled={pending || blocked !== null}
              autoFocus
              minRows={1}
              maxHeight="8rem"
              namespace="hints-ask-question"
            />
          </Fill>
          <IconButton
            icon={sendIcon}
            label="Ask"
            variant="default"
            loading={pending}
            disabled={blocked !== null || draft.trim() === ""}
            onClick={() => void send(draft, true)}
          />
        </Stack>
      }
    />
  );
}
