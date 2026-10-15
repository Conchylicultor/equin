import { conversationAttachments } from "@plugins/tasks/plugins/tasks-core/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { postConversationTurn } from "../../core/endpoints";
import { resolveAttachmentRefs } from "./resolve-prompt-attachments";
import { submitTurn } from "./turns";

// JSON: { text, turnId? }. The text is markdown that may contain
// `![](/api/attachments/<id>)` refs; we resolve those into `@<disk-path>`
// before handing the prompt to the agent and additively link the referenced
// attachments to this conversation so the orphan sweep leaves them alone.
// `turnId` is the client's ledger id: a repeated request with it changes
// nothing (turns.ts).
export const handlePostTurn = implement(
  postConversationTurn,
  async ({ params, body }) => {
    const id = params.id;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new HttpError(400, "invalid id");
    }

    const { text: resolved, attachmentIds } = await resolveAttachmentRefs(
      body.text,
    );
    const finalText = resolved.trim();
    if (finalText.length === 0) {
      throw new HttpError(400, "text required");
    }

    if (attachmentIds.length > 0) {
      await conversationAttachments.add(id, attachmentIds);
    }

    // A conversation still `starting` cannot take input yet: the turn is held
    // and delivered once it can (turns.ts).
    let outcome;
    try {
      outcome = await submitTurn(id, {
        id: body.turnId,
        kind: "turn",
        text: body.text,
        typedText: finalText,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw new HttpError(404, "Not found");
      }
      throw err;
    }
    if (outcome.kind === "not-found") throw new HttpError(404, "Not found");

    return {
      resolvedText: finalText,
      held: outcome.turn.state === "held",
      turnId: outcome.turn.id,
    };
  },
);
