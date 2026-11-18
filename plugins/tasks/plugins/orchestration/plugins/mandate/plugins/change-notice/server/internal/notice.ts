import type { SectionRefresh } from "@plugins/conversations/plugins/system-prompt/plugins/composer/server";

/**
 * A change notice: `lead` says what changed (and that it is information
 * only), then — since the agent's system prompt is fixed for the life of its
 * process — every section the change touches, rendered again, and the ones
 * that no longer apply named. Its next spawn renders them anyway.
 */
export function noticeText(
  lead: string,
  sections: readonly SectionRefresh[],
): string {
  const current = sections.filter((s) => s.kind === "current");
  const withdrawn = sections.filter((s) => s.kind === "withdrawn");
  const lines = [
    lead,
    "",
    "The parts of your system prompt this changes are now out of date — each `<equin-context>` below replaces the one of the same id:",
    "",
  ];
  if (current.length === 0)
    lines.push(
      "(none apply now — no rules beyond what your equin tools' descriptions say)",
    );
  else lines.push(current.map((s) => s.text).join("\n\n"));
  if (withdrawn.length > 0)
    lines.push(
      "",
      "No longer apply — disregard these parts of your system prompt:",
      ...withdrawn.map((s) => `- ${s.label} (\`${s.id}\`)`),
    );
  lines.push(
    "",
    "If you have work in progress, carry on with exactly that work under these rules. Otherwise, acknowledge in one line and stop.",
  );
  return lines.join("\n");
}

/** The mandate change notice's lead: a mandate says what the agent may do,
 * never that it should do anything now. */
export const MANDATE_CHANGE_LEAD =
  "Your task's mandate was just changed by the user. This is for your information only — it is NOT a request to act: do not start, change or stop any work because of it, and do not use any newly granted capability unless the user explicitly asks you to. Your equin MCP tools were refreshed to match.";
