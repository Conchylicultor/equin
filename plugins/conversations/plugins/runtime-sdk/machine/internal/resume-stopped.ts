import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { submitTurn } from "@plugins/conversations/server";
import {
  resumeStoppedConversations,
  resumeTurnText,
  type ResumeStoppedResult,
} from "../../core";
import { stopErrorOf } from "../../server/internal/rows";

// Resume: one ordinary turn per conversation, whatever API error stopped it —
// its words name the error when the agent must know it is gone (a usage limit).
// The sdk runtime's send moves an idle agent running on another account than
// the one a launch picks now onto that account before typing it, so nothing here knows
// about accounts or kinds of failure. One at a time: each
// restart is a process start, and a failure is told per conversation rather
// than ending the rest.
export async function resumeStopped(
  ids: readonly string[],
): Promise<ResumeStoppedResult[]> {
  const results: ResumeStoppedResult[] = [];
  for (const id of ids) {
    try {
      const text = resumeTurnText(await stopErrorOf(id));
      const outcome = await submitTurn(id, {
        kind: "turn",
        text,
        typedText: text,
      });
      switch (outcome.kind) {
        case "not-found":
          results.push({ id, kind: "not-found" });
          break;
        case "stopped":
          results.push({
            id,
            kind: "failed",
            message: `Conversation is ${outcome.status}`,
          });
          break;
        case "submitted":
          results.push({ id, kind: "resumed" });
          break;
      }
    } catch (err) {
      // Reported to the caller, per conversation (the ledger row is marked
      // failed by submitTurn itself).
      if (!(err instanceof Error)) throw err;
      results.push({ id, kind: "failed", message: err.message });
    }
  }
  return results;
}

export const handleResumeStopped = implementMachine(
  resumeStoppedConversations,
  async ({ body }) => ({ results: await resumeStopped(body.ids) }),
);
