import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const groupsIcon = symbol("groups");

interface AgentListingDeltaPayload {
  type: "agent_listing_delta";
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
}

interface ParsedAgent {
  name: string;
  description: string;
}

/** Parse `- name: description (Tools: …)` lines into name + description, mirroring skill-listing. */
function parseAgents(lines: string[]): ParsedAgent[] {
  return lines
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

export function AgentListingDeltaView({ event }: AttachmentRendererProps) {
  const att = event.attachment as AgentListingDeltaPayload;
  const agents = parseAgents(att.addedLines ?? []);
  const removed = att.removedTypes ?? [];
  const added = agents.length || (att.addedTypes?.length ?? 0);

  const counts = att.isInitial
    ? `${added} agent${added === 1 ? "" : "s"}`
    : [
        added > 0 ? `+${added}` : null,
        removed.length > 0 ? `−${removed.length}` : null,
      ]
        .filter(Boolean)
        .join(" ") || "no changes";

  return (
    <CollapsibleCard
      icon={<Icon icon={groupsIcon} className="size-3.5" />}
      label={att.isInitial ? "Agents available" : "Agents delta"}
      note={`· ${counts}`}
    >
      {agents.length === 0 && removed.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No agents listed.
        </Text>
      ) : (
        <Stack as="ul" gap="2xs">
          {agents.map((agent) => (
            <Text
              as="li"
              variant="caption"
              key={agent.name}
              className="text-muted-foreground"
            >
              <span className="font-semibold text-foreground">
                {agent.name}
              </span>
              {agent.description && (
                <>
                  {" "}
                  <span className="text-muted-foreground/60">
                    — {agent.description}
                  </span>
                </>
              )}
            </Text>
          ))}
          {removed.map((name) => (
            <Text
              as="li"
              variant="caption"
              key={name}
              className="text-muted-foreground line-through"
            >
              <span className="text-destructive no-underline">−</span> {name}
            </Text>
          ))}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
