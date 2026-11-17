import type { MandateSectionRefresh } from "@plugins/conversations/plugins/system-prompt/plugins/composer/server";

/**
 * The notice: the agent's MCP tools were already refreshed (reconnected), but
 * its system prompt is fixed for the life of its process, so this turn carries
 * every section of it that follows the mandate, rendered again (`## Mandate`,
 * the supervisor prompt, the task tree…) — and names the ones that no longer
 * apply. Its next spawn renders them anyway. Information only: a mandate
 * change says what the agent may do, never that it should do anything now.
 */
export function noticeText(sections: readonly MandateSectionRefresh[]): string {
  const current = sections.filter((s) => s.kind === "current");
  const withdrawn = sections.filter((s) => s.kind === "withdrawn");
  const lines = [
    "Your task's mandate was just changed by the user. This is for your information only — it is NOT a request to act: do not start, change or stop any work because of it, and do not use any newly granted capability unless the user explicitly asks you to.",
    "",
    "Your equin MCP tools were refreshed to match. The parts of your system prompt that depend on the mandate are now out of date — each `<equin-context>` below replaces the one of the same id:",
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
