import { rowOrStale } from "@plugins/network/plugins/live/web";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const descriptionIcon = symbol("description");

type SkillInput = { skill: string; args?: string };

export function SkillToolView({ event }: ToolRendererProps) {
  const input = event.input as SkillInput;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; input is `as`-cast from unknown
  const skillName = input.skill ?? "";
  const args = typeof input.args === "string" ? input.args : "";
  const injected = event.injectedContext ?? [];

  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  const openPane = useOpenPane();

  // Project skills live at `.claude/skills/<name>/SKILL.md` (git-tracked, so the
  // file-peek pane's fuzzy resolver finds them). Clicking the chip opens the
  // markdown file view in a side pane. Inert until the conversation (and so
  // its worktree) is known.
  const skillFilePath = `.claude/skills/${skillName}/SKILL.md`;
  const skillFile = conversation
    ? openPane.to(
        filePeekPane,
        { worktree: conversation.attemptId, filePath: skillFilePath },
        { mode: "push" },
      )
    : undefined;

  const skillChip = (
    <LinkChip
      activation={skillFile}
      mono
      leading={<Icon icon={descriptionIcon} />}
      tooltip={`Open ${skillFilePath}`}
    >
      {skillName}
    </LinkChip>
  );

  const summary = args ? (
    <Text className="text-muted-foreground">{args}</Text>
  ) : undefined;

  return (
    <ToolCallCard event={event} summary={summary} leading={skillChip}>
      {args && (
        <ToolSection label="Arguments" copyText={args}>
          <ToolCode>{args}</ToolCode>
        </ToolSection>
      )}
      {injected.map((ctx, i) => (
        <ToolSection key={i} label="Skill content" copyText={ctx}>
          <ToolCode>{ctx}</ToolCode>
        </ToolSection>
      ))}
    </ToolCallCard>
  );
}
