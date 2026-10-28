import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { capabilityEntries } from "./contribution";
import { conversationMandate, grantIn } from "./resolve";

/**
 * Renders the `## Mandate` section: one line per granted capability, in
 * capability-id order, from each capability's own describe. Names none of
 * them. A grant this process registers no capability for is skipped (newer
 * code may have stored it); an invalid value throws, failing `initialize`.
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
    const value = grantIn(entry.cap, mandate.policy);
    if (value !== null) lines.push(`- ${entry.describe(value)}`);
  }
  if (lines.length === 0) return null;
  return [
    "## Mandate",
    "",
    "What you may do in this task's subtree:",
    "",
    ...lines,
  ].join("\n");
}

export const mandateInstructions = Mcp.instructions({
  id: "mandate",
  render: ({ conversationId }) => renderMandateInstructions(conversationId),
});
