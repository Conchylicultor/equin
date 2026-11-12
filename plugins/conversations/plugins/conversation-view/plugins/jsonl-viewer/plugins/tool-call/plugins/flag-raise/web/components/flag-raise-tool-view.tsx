import { z } from "zod";
import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  FirstLine,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const flagIcon = symbol("flag");

const flagIconClass = cn("size-4 text-warning", rigidClass());

/** `flag_raise`'s input, as its card draws it. */
export const FlagRaiseInputSchema = z.looseObject({ reason: z.string() });
type FlagRaiseInput = z.infer<typeof FlagRaiseInputSchema>;

export function FlagRaiseToolView({
  event,
  input,
}: ToolViewProps<FlagRaiseInput>) {
  return (
    <ToolCallCard event={event} summary="Flagged for review" defaultOpen>
      <Stack
        direction="row"
        gap="sm"
        align="start"
        className="rounded-md border border-warning/30 bg-warning/10 px-md py-sm"
      >
        <FirstLine variant="caption">
          <Icon icon={flagIcon} className={flagIconClass} />
        </FirstLine>
        <Text as="p" variant="caption" className="whitespace-pre-wrap">
          {input.reason}
        </Text>
      </Stack>
      {event.result?.isError && (
        <Text as="p" variant="caption" className="text-destructive">
          {event.result.content}
        </Text>
      )}
    </ToolCallCard>
  );
}
