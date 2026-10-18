import { asc, desc, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { pushes } from "../tables";
import { PushLedger } from "../push-ledger/service";
import type { Push } from "../schema";

/**
 * The push accessors whose EMPTINESS a consumer could misread, each guaranteed
 * to see a ledger that covers `main` before it reads.
 *
 * `pushes` is a projection of `main`'s trailer-bearing history, not the output of
 * a background job (see ../push-ledger/ and the host's `PushLedger`). Putting the guarantee inside the reader
 * is what keeps it from being a rule every future consumer has to remember: there
 * is no accessor on the barrel that can hand back a ledger that has not caught
 * up. The ungated reads the projection itself needs live in
 * ../push-ledger/raw-reads.ts and are not exported from the plugin.
 *
 * The guarantee is about COMPLETENESS. Interpretation is still governed by I3
 * (`tasks/attempt-work/CLAUDE.md`): a row proves a push happened, and even a
 * complete ledger cannot see a commit that carries no trailer, so its absence
 * still may not be read as proof that nothing landed.
 */

export async function listPushesForAttempt(attemptId: string): Promise<Push[]> {
  await PushLedger.get().ensureFresh();
  return db
    .select()
    .from(pushes)
    .where(eq(pushes.attemptId, attemptId))
    .orderBy(desc(pushes.createdAt));
}

export async function listPushesByPushId(pushId: string): Promise<Push[]> {
  await PushLedger.get().ensureFresh();
  return db
    .select()
    .from(pushes)
    .where(eq(pushes.pushId, pushId))
    .orderBy(asc(pushes.createdAt));
}
