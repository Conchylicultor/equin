import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { submitTurn } from "@plugins/conversations/server";
import {
  RESUME_TURN_TEXT,
  resumeLimitedConversations,
  type ResumeLimitedResult,
} from "../../core";

// Resume: one ordinary turn per conversation. The sdk runtime's send moves an
// agent stopped at its account's limit onto the account a launch picks now
// before typing it, so nothing here knows about accounts. One at a time: each
// restart is a process start, and a failure is told per conversation rather
// than ending the rest.
export const handleResumeLimited = implementMachine(
  resumeLimitedConversations,
  async ({ body }) => {
    const results: ResumeLimitedResult[] = [];
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
