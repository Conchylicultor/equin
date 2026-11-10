import { HOOK_OUTPUT_CAP } from "@plugins/conversations/plugins/compaction-context/core";

/**
 * The turn that hands the agent the whole compaction context the CLI cut. It
 * replaces what the agent got from the hook, and asks for nothing new.
 */
export function fallbackTurnText(context: string): string {
  return [
    `What equin handed back after your context was compacted did not reach you whole: it is ${context.length} characters, and Claude Code keeps only about ${HOOK_OUTPUT_CAP} of a hook's output (you got a preview, or nothing). Here it is in full. Follow it as if it had arrived with the compaction — it replaces that preview.`,
    "",
    "This is not a request to act: if you have work in progress, carry on with exactly that work. Otherwise, acknowledge in one line and stop.",
    "",
    context,
  ].join("\n");
}
