import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { saveBootTrace } from "../../shared/endpoints";
import { _bootTraces } from "./tables";

// Persist the posted snapshot under a generated id, stamping the worktree the
// permalink stays scoped to. Returns the id the client builds the URL from.
export const handleSaveBootTrace = implement(
  saveBootTrace,
  async ({ body }) => {
    const worktree = runtimeNamespace();
    const [row] = await db
      .insert(_bootTraces)
      .values({ worktree, snapshot: body.snapshot })
      .returning({ id: _bootTraces.id });
    if (!row) throw new HttpError(500, "saveBootTrace: insert returned no row");
    return { id: row.id };
  },
);
