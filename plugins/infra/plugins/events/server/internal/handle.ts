import { eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  listEmissions,
  listTriggers,
  deleteTriggerEndpoint,
  patchTriggerEndpoint,
} from "../../core";
import { triggerTableRegistry } from "./registry";
import { deleteTrigger } from "./trigger";
import { loadEmissions, loadTriggers } from "./resources";

export const handleListEmissions = implement(listEmissions, async ({ req }) => {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  return loadEmissions(limit);
});

export const handleListTriggers = implement(listTriggers, async () => {
  return { rows: await loadTriggers() };
});

export const handleDeleteTrigger = implement(
  deleteTriggerEndpoint,
  async ({ params }) => {
    if (!params.id) throw new HttpError(400, "id required");
    await deleteTrigger(params.id);
  },
);

export const handlePatchTrigger = implement(
  patchTriggerEndpoint,
  async ({ params, body }) => {
    if (!params.id) throw new HttpError(400, "id required");
    for (const table of triggerTableRegistry.values()) {
      await db
        // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on untyped PgTable.
        .update(table as any)
        .set({ enabled: body.enabled })
        // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on untyped PgTable.
        .where(eq((table as any).id as AnyPgColumn, params.id));
    }
  },
);
