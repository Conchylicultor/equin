import { and, eq, inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  claimPlots,
  geometryOf,
  movePlot,
  type PlotWrite,
  type PlotWritesResult,
} from "../../core";
import { _islePlots } from "./tables";

/** Thrown inside the transaction to roll a batch back as `stale`. */
class StaleBatch extends Error {
  constructor() {
    super("isle plots: a plot this batch makes was made meanwhile");
  }
}

const OCCUPANT_UQ = "isle_plots_world_occupant_idx";

/**
 * An app landing on a plot while it already stands on another one OUTSIDE the
 * batch (the batch's own occupants are checked distinct up front): the writer
 * read a placement where the app stood elsewhere or nowhere, so its read is
 * stale. node-postgres surfaces it as SQLSTATE 23505 plus the constraint.
 */
function isOccupantViolation(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string } | null;
  return pg?.code === "23505" && pg.constraint === OCCUPANT_UQ;
}

/**
 * Applies a batch of plot writes in ONE transaction, compare-and-set: every
 * written plot is locked and checked against what the writer read (absent, or
 * its occupant); a single mismatch writes nothing and answers `stale`. Then
 * the written plots are vacated and each takes its occupant. An app written
 * onto two plots of one batch is a bug (thrown); an app landing on a plot while
 * it stands on another plot the batch does not touch means the writer's read
 * is stale — the unique `(world, occupant)` index refuses it, answered `stale`.
 */
async function applyWrites(
  world: string,
  writes: readonly PlotWrite[],
  movedByUser: boolean,
): Promise<PlotWritesResult> {
  const ids = writes.map((w) => w.plot.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("isle plots: a batch writes one plot twice");
  const occupants = writes.flatMap((w) => (w.occupant ? [w.occupant] : []));
  if (new Set(occupants).size !== occupants.length)
    throw new Error("isle plots: a batch puts one app on two plots");
  try {
    return await db.transaction(async (tx) => {
      const current = await tx
        .select({ plotId: _islePlots.plotId, occupant: _islePlots.occupant })
        .from(_islePlots)
        .where(
          and(eq(_islePlots.world, world), inArray(_islePlots.plotId, ids)),
        )
        .for("update");
      const byId = new Map(current.map((r) => [r.plotId, r.occupant]));
      for (const w of writes) {
        const held = byId.has(w.plot.id);
        if (
          w.expect.kind === "absent"
            ? held
            : !held || byId.get(w.plot.id) !== w.expect.appId
        )
          return { outcome: "stale" as const };
      }
      if (current.length)
        await tx
          .update(_islePlots)
          .set({ occupant: null })
          .where(
            and(eq(_islePlots.world, world), inArray(_islePlots.plotId, ids)),
          );
      for (const w of writes) {
        const row = {
          world,
          plotId: w.plot.id,
          slot: w.plot.slot,
          n: w.plot.n,
          seq: w.plot.seq,
          category: w.plot.category,
          geometry: geometryOf(w.plot),
          occupant: w.occupant,
        };
        if (w.expect.kind === "absent") {
          // another writer may have made it since the check (no row to lock):
          // then this batch is stale, and rolls back whole
          const made = await tx
            .insert(_islePlots)
            .values({ ...row, movedByUser })
            .onConflictDoNothing({
              target: [_islePlots.world, _islePlots.plotId],
            })
            .returning({ plotId: _islePlots.plotId });
          if (!made.length) throw new StaleBatch();
        } else
          await tx
            .update(_islePlots)
            .set({
              geometry: row.geometry,
              occupant: row.occupant,
              ...(movedByUser && { movedByUser: true }),
            })
            .where(
              and(
                eq(_islePlots.world, world),
                eq(_islePlots.plotId, w.plot.id),
              ),
            );
      }
      return { outcome: "applied" as const };
    });
  } catch (err) {
    if (err instanceof StaleBatch || isOccupantViolation(err))
      return { outcome: "stale" };
    throw err;
  }
}

export const handleClaimPlots = implement(claimPlots, ({ body }) =>
  applyWrites(body.world, body.writes, false),
);

export const handleMovePlot = implement(movePlot, ({ body }) =>
  applyWrites(body.world, body.writes, true),
);
