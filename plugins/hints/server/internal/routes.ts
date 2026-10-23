import { inArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { markHintSeenEndpoint, resetHintsEndpoint } from "../../core";
import { _hintSeen } from "./tables";

export const handleMarkHintSeen = implement(
  markHintSeenEndpoint,
  async ({ body }) => {
    // One upsert: a tour marked at its start (outcome null) gets its outcome
    // at its end; a re-shown tip (after a reset) is simply seen again.
    await db
      .insert(_hintSeen)
      .values({ hintId: body.id, outcome: body.outcome, seenAt: sql`now()` })
      .onConflictDoUpdate({
        target: _hintSeen.hintId,
        set: { outcome: body.outcome, seenAt: sql`now()` },
      });
  },
);

export const handleResetHints = implement(
  resetHintsEndpoint,
  async ({ body }) => {
    if (body.ids.length === 0) return;
    await db.delete(_hintSeen).where(inArray(_hintSeen.hintId, body.ids));
  },
);
