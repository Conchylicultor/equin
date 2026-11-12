import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const autoAwesomeIcon = symbol("auto-awesome");

interface SkillListingPayload {
  type: "skill_listing";
  content: string;
  skillCount: number;
  isInitial: boolean;
}

interface ParsedSkill {
  name: string;
  description: string;
}

function parseSkills(content: string): ParsedSkill[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const body = line.slice(2);
      const colonIdx = body.indexOf(": ");
      if (colonIdx === -1) return { name: body, description: "" };
      return {
        name: body.slice(0, colonIdx),
        description: body.slice(colonIdx + 2),
      };
    });
}

export function SkillListingView({ event }: AttachmentRendererProps) {
  const att = event.attachment as SkillListingPayload;
  const skills = parseSkills(att.content ?? "");
  const count = att.skillCount ?? skills.length;

  return (
    <CollapsibleCard
      icon={<Icon icon={autoAwesomeIcon} className="size-3.5" />}
      label="Skills available"
      note={`· ${count} skill${count === 1 ? "" : "s"}`}
    >
      {skills.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No skills listed.
        </Text>
      ) : (
        <Stack as="ul" gap="2xs">
          {skills.map((skill) => (
            <Text
              as="li"
              variant="caption"
              key={skill.name}
              className="text-muted-foreground"
            >
              <span className="font-semibold text-foreground">
                {skill.name}
              </span>
              {skill.description && (
                <>
                  {" "}
                  <span className="text-muted-foreground/60">
                    — {skill.description}
                  </span>
                </>
              )}
            </Text>
          ))}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
