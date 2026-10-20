import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import {
  classifyConversation,
  setConversationCategory,
} from "../../shared/endpoints";
import { upsertCategoryRows } from "../../server/internal/store";
import { findCategory } from "./categories";
import { classifyConversationJob } from "./classify-job";

// Enqueues the run and answers 204 at once: the classification lands through
// the conversation-categories collection when the job finishes. Without
// `categoryIds` every category is re-classified; a list restricts the run to
// those categories.
export const handleClassify = implementMachine(
  classifyConversation,
  async ({ params, body }) => {
    await classifyConversationJob.enqueue({
      conversationId: params.conversationId,
      categoryIds: body.categoryIds,
      force: true,
    });
  },
);

export const handleSetCategory = implementMachine(
  setConversationCategory,
  async ({ params, body }) => {
    // Validate against the configured categories — the UI offers these as
    // choices, but a stale tab or a direct API caller could pass anything, and
    // the chip must never display an item the picker no longer offers.
    const category = findCategory(body.categoryId);
    if (!category) {
      throw new HttpError(
        400,
        `category "${body.categoryId}" is not in the configured list`,
      );
    }
    if (!category.items.some((i) => i.name === body.item)) {
      throw new HttpError(
        400,
        `item "${body.item}" is not in category "${category.name}"`,
      );
    }

    await upsertCategoryRows(
      params.conversationId,
      [{ categoryId: body.categoryId, item: body.item }],
      "manual",
    );
  },
);
