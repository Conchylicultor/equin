import { SystemPrompt } from "@plugins/conversations/plugins/system-prompt/server";
import { capabilityEntries } from "./contribution";
import { conversationMandate, grantIn } from "./resolve";

/**
 * Renders the `## Mandate` section: one line per granted capability that has
 * something to say (its describe is not `null`), in capability-id order. Names
 * none of them. `null` when no line is left — the tools the mandate grants say
 * the rest. A grant this process registers no capability for is skipped (newer
 * code may have stored it); an invalid value throws.
 */
export async function renderMandateInstructions(
  conversationId: string,
): Promise<string | null> {
  const mandate = await conversationMandate(conversationId);
  if (mandate.kind === "none") return null;
  const entries = [...capabilityEntries().values()].sort((a, b) =>
    a.cap.id.localeCompare(b.cap.id),
  );
  const lines: string[] = [];
  for (const entry of entries) {
    const value = grantIn(entry.cap, mandate.policy, mandate.at);
    if (value === null) continue;
    const line = entry.describe(value);
    if (line !== null) lines.push(`- ${line}`);
  }
  if (lines.length === 0) return null;
  return ["## Mandate", "", ...lines].join("\n");
}

/** The Mandate, in the agent's system prompt (rendered at every spawn). */
export const mandateSection = SystemPrompt.Section({
  id: "mandate",
  label: "Mandate",
  render: (conversationId) => renderMandateInstructions(conversationId),
});
