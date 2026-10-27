import type { BackgroundWork } from "@plugins/conversations/core";
import type { RewindCutPreview } from "../../core";

export type RewindMode = "rewind" | "fork";

const named = (work: BackgroundWork): string =>
  work.description ? `“${work.description}”` : `a background ${work.tool} task`;

/**
 * What the user should know before going back to a message, one plain sentence
 * per line. Empty means nothing worth a dialog: go straight through.
 *
 * A fork leaves the original conversation whole, so later messages and a
 * running turn are not its concern — only what the FORKED agent will wrongly
 * believe about background work.
 */
export function describeLosses(
  preview: RewindCutPreview,
  mode: RewindMode,
): string[] {
  const { losses } = preview;
  const lines: string[] = [];
  if (mode === "rewind") {
    if (preview.turnRunning) {
      lines.push(
        "The agent is working right now. Its current turn will be stopped.",
      );
    }
    if (losses.laterUserTurns > 0) {
      lines.push(
        losses.laterUserTurns === 1
          ? "1 later message of yours, and everything after it, is removed from this conversation."
          : `${losses.laterUserTurns} later messages of yours, and everything after them, are removed from this conversation.`,
      );
    }
  }
  const agent = mode === "rewind" ? "The agent" : "The forked agent";
  for (const work of losses.lostReports) {
    lines.push(
      `The report from ${named(work)} arrived after this message, so it is lost. ${agent} will be told that work did not finish.`,
    );
  }
  for (const work of losses.unreported) {
    lines.push(
      mode === "rewind"
        ? `${named(work)} has not reported back. If it is still running it will be stopped, and the agent will be told it did not finish.`
        : `${named(work)} has not reported back. The forked agent will be told it did not finish.`,
    );
  }
  if (lines.length > 0) {
    lines.push("Files in the worktree are not changed.");
  }
  return lines;
}
