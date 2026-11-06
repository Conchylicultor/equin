/**
 * The notice: the agent's MCP tools were already refreshed (reconnected), but
 * the server instructions it read at its start are not re-read, so this turn
 * carries their new `## Mandate` section. Information only: a mandate change
 * says what the agent may do, never that it should do anything now.
 */
export function noticeText(section: string | null): string {
  return [
    "Your task's mandate was just changed by the user. This is for your information only — it is NOT a request to act: do not start, change or stop any work because of it, and do not use any newly granted capability unless the user explicitly asks you to.",
    "",
    "Your equin MCP tools were refreshed to match; the `## Mandate` section of the equin server instructions you read when this conversation started is now out of date — follow this one instead:",
    "",
    section ??
      "## Mandate\n\nYour mandate grants nothing in this task's subtree.",
    "",
    "If you have work in progress, carry on with exactly that work under these rules. Otherwise, acknowledge in one line and stop.",
  ].join("\n");
}
