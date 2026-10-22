import fs from "node:fs/promises";
import {
  createConversation,
  deleteConversation,
} from "@plugins/conversations/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { generateConversationSummary } from "../../shared/endpoints";
import { buildSummarizePayload } from "./prompt";
import { SUMMARY_MODEL_CHOICE } from "./mcp-tools";

// Cap how long the summarising conversation may live before we reap it.
const CLEANUP_AFTER_MS = 5 * 60 * 1000;

export const handleGenerate = implementMachine(
  generateConversationSummary,
  async ({ params }) => {
    const { conversationId } = params;
    const contextPath = `/tmp/singularity-summary-${conversationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`;

    let payload;
    try {
      payload = await buildSummarizePayload(conversationId, contextPath);
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
      );
    }

    await fs.writeFile(contextPath, payload.context, "utf8");

    const parent = await getConversation(conversationId);
    if (!parent) {
      throw new HttpError(
        404,
        `Parent conversation ${conversationId} not found`,
      );
    }

    const conv = await createConversation({
      prompt: payload.prompt,
      model: SUMMARY_MODEL_CHOICE,
      kind: "system",
      spawnedBy: "conversation-summary",
      attemptId: parent.attemptId,
    });

    setTimeout(() => {
      // eslint-disable-next-line promise-safety/no-bare-catch
      deleteConversation(conv.id).catch((err) => {
        console.error(
          `[conversation-summary] cleanup of ${conv.id} failed`,
          err,
        );
      });
      void fs.unlink(contextPath);
    }, CLEANUP_AFTER_MS).unref();

    return {
      spawnedConversationId: conv.id,
      turnCount: payload.turnCount,
    };
  },
);
