import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  COMPACTION_CONTEXT_BUDGET,
  compactionContext,
  PART_SEPARATOR,
} from "../../core";
import { CompactionContext } from "./registry";
import { recordSend } from "./sends";

/**
 * Every contribution's part, the empty ones dropped: the `whole` parts first,
 * in registration order and never cut, then the `fit` parts in the room left
 * under {@link COMPACTION_CONTEXT_BUDGET}. A contribution that throws — or a
 * `fit` part longer than its room — fails the request: the hook surfaces it as
 * a hook error rather than the agent going on without part of its context,
 * silently.
 *
 * The answer is recorded before it is returned, so `delivery-check` can read
 * back from the transcript whether the agent got it whole.
 */
export const handleCompactionContext = implement(
  compactionContext,
  async ({ params }) => {
    const sources = CompactionContext.getContributions();
    const parts: string[] = [];
    const length = () =>
      parts.reduce((n, p) => n + p.length, 0) +
      PART_SEPARATOR.length * Math.max(0, parts.length - 1);
    for (const source of sources) {
      if (source.size !== "whole") continue;
      const part = await source.restore(params.id);
      if (part.trim().length > 0) parts.push(part);
    }
    for (const source of sources) {
      if (source.size !== "fit") continue;
      const room =
        COMPACTION_CONTEXT_BUDGET -
        length() -
        (parts.length > 0 ? PART_SEPARATOR.length : 0);
      if (room <= 0) continue;
      const part = await source.restore(params.id, room);
      if (part.length > room) {
        throw new Error(
          `compaction-context: part "${source.id}" is ${part.length} characters, over the ${room} it was given`,
        );
      }
      if (part.trim().length > 0) parts.push(part);
    }
    const context = parts.join(PART_SEPARATOR);
    if (context.length > 0) {
      await recordSend({
        conversationId: params.id,
        context,
        sentAt: new Date(),
      });
    }
    return { context };
  },
);
