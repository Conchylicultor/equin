import type {
  InstructionPart,
  JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";
import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const campaignIcon = symbol("campaign");

type PrepromptEvent = Extract<JsonlEvent, { kind: "preprompt" }>;

/** A section id as a sentence-case heading: `tree-digest` → `Tree digest`. */
function headingOfId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A part's heading: the preprompt by role, a section by the label the
 *  composer wrote — or, on a transcript written before the wrapper carried
 *  one, its id as a heading. */
function partLabel(part: InstructionPart): string {
  return part.kind === "preprompt"
    ? "Special instructions"
    : (part.label ?? headingOfId(part.id));
}

function partKey(part: InstructionPart): string {
  return part.kind === "preprompt" ? "preprompt" : `section:${part.id}`;
}

function InstructionPartFold({ part }: { part: InstructionPart }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="gap-xs rounded-md text-caption text-muted-foreground hover:text-foreground">
        <CollapsibleChevron className="size-3" />
        <span>{partLabel(part)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Text
          as="div"
          variant="caption"
          className="whitespace-pre-wrap break-words pt-xs pl-md text-muted-foreground"
        >
          {part.text}
        </Text>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Everything equin appended to the agent's system prompt — its preprompt and
 * every contributed section (mandate, page instructions, supervisor roles,
 * task tree, …) — as one Instructions card, each part folding on its own.
 */
export function PrepromptRow({ event }: { event: JsonlEvent }) {
  const e = event as PrepromptEvent;
  const count = e.parts.length;

  return (
    <CollapsibleCard
      className="border-primary/30 bg-primary/5"
      icon={<Icon icon={campaignIcon} className="size-3.5 text-primary-text" />}
      label={<span className="text-primary-text">Instructions</span>}
      note={`· ${count} ${count === 1 ? "section" : "sections"}`}
    >
      <Stack gap="xs">
        {e.parts.map((part) => (
          <InstructionPartFold key={partKey(part)} part={part} />
        ))}
      </Stack>
    </CollapsibleCard>
  );
}
