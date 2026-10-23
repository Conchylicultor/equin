import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { submitTurn } from "@plugins/conversations/server";
import {
  RESUME_TURN_TEXT,
  resumeStoppedConversations,
  type ResumeStoppedResult,
} from "../../core";

// Resume: one ordinary turn per conversation, whatever API error stopped it.
// The sdk runtime's send moves an agent stopped at its account's usage limit
// onto the account a launch picks now before typing it, so nothing here knows
// about accounts or kinds of failure. One at a time: each
// restart is a process start, and a failure is told per conversation rather
// than ending the rest.
export const handleResumeStopped = implementMachine(
  resumeStoppedConversations,
  async ({ body }) => {
    const results: ResumeStoppedResult[] = [];
    for (const id of body.ids) {
      try {
        const outcome = await submitTurn(id, {
          kind: "turn",
          text: RESUME_TURN_TEXT,
          typedText: RESUME_TURN_TEXT,
        });
        results.push(
          outcome.kind === "not-found"
            ? { id, kind: "not-found" }
            : { id, kind: "resumed" },
        );
      } catch (err) {
        // Reported to the caller, per conversation (the ledger row is marked
        // failed by submitTurn itself).
        if (!(err instanceof Error)) throw err;
        results.push({ id, kind: "failed", message: err.message });
      }
    }
    return { results };
  },
);
