import { resumeConversation } from "@plugins/conversations/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { restoreBatch } from "../../shared/endpoints";

type RestoreResult =
  { id: string; ok: true } | { id: string; ok: false; error: string };

export const handleRestoreBatch = implementMachine(
  restoreBatch,
  async ({ body }) => {
    const { ids } = body;
    if (ids.length === 0) {
      return { results: [] satisfies RestoreResult[] };
    }

    const results: RestoreResult[] = await Promise.all(
      ids.map(async (id): Promise<RestoreResult> => {
        try {
          await resumeConversation(id);
          return { id, ok: true };
        } catch (err) {
          return {
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return { results };
  },
);
