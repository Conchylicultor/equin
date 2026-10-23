import { useRef, useState } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useBlockWriting } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { useSteadyReveal } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/steady-reveal/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

type AssistantThinkingEvent = Extract<JsonlEvent, { kind: "assistant-thinking" }>;

const THOUGHT_CLASS =
  "whitespace-pre-wrap break-words font-mono text-muted-foreground";

/**
 * A thought, as a card that always opens. While the model is still thinking
 * (the stand-in of the message's newest block) it is open on the thought as it
 * is written — revealed at the reply's steady pace, or a placeholder until the
 * first words arrive — and it folds the moment the next block begins (the
 * reply's first token, a tool call), not when the transcript catches up; its
 * finished row lands folded. A reader's own toggle wins over both. Folded, the
 * header carries the thought's first sentence, which stays put as the rest
 * streams in; open, the header drops it rather than repeat what the body shows.
 */
export function AssistantThinkingRow({ event }: { event: JsonlEvent }) {
  const e = event as AssistantThinkingEvent;
  const writing = useBlockWriting();
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? writing;
  const lead = open ? "" : firstSentence(e.thinking);

  return (
    <CollapsibleCard
      label="Thinking"
      summary={lead === "" ? undefined : lead}
      open={open}
      onOpenChange={setChosen}
    >
      {writing ? (
        <StreamingThought text={e.thinking} />
      ) : e.thinking === "" ? (
        <Text
          as="div"
          variant="caption"
          className="italic text-muted-foreground"
        >
          No thinking text was recorded for this step.
        </Text>
      ) : (
        <Text as="div" variant="caption" className={THOUGHT_CLASS}>
          {e.thinking}
        </Text>
      )}
    </CollapsibleCard>
  );
}

/** The thought being written: placeholder lines until its first words, then a steady reveal. */
function StreamingThought({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const shown = useSteadyReveal(text, body, "muted");
  if (text === "")
    return (
      <Stack gap="sm">
        <Loading variant="block" className="h-2.5 w-3/4" />
        <Loading variant="block" className="h-2.5 w-1/2" />
      </Stack>
    );
  return (
    <div ref={body}>
      <Text as="div" variant="caption" className={THOUGHT_CLASS}>
        {text.slice(0, shown)}
      </Text>
    </div>
  );
}

/** The thought's first sentence, on one line: what the folded header shows. */
function firstSentence(thinking: string): string {
  const line = thinking.trim().split("\n")[0] ?? "";
  return (line.split(/(?<=[.?!])\s/)[0] ?? "").replaceAll("**", "").trim();
}
