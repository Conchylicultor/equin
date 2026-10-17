import { implement } from "@plugins/infra/plugins/endpoints/server";
import { compactionContext } from "../../core/endpoints";
import { CompactionContext } from "./registry";

/**
 * Every contribution's part, in registration order, the empty ones dropped. A
 * contribution that throws fails the request: the hook surfaces it as a hook
 * error rather than the agent going on without part of its context, silently.
 */
export const handleCompactionContext = implement(
  compactionContext,
  async ({ params }) => {
    const parts: string[] = [];
    for (const source of CompactionContext.getContributions()) {
      const part = await source.restore(params.id);
      if (part.trim().length > 0) parts.push(part);
    }
    return { context: parts.join("\n\n") };
  },
);
