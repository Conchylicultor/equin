import { useEffect, useState } from "react";
import {
  adoptHomeCarve,
  homeCarveBuilt,
  islandsInPlay,
  type Placement,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { bakeWorkersAvailable, leaseBakePool } from "./bake-pool";

/** Whether the island shapes a placement reads are in: `loading` while workers build them. */
export type IslandShapes = "loading" | "ready";

/**
 * Builds, in the bake workers, the island shapes (and the home carve) that
 * drawing `placement` or placing the next app reads (`islandsInPlay`), and
 * restores them into `M` — so the page never builds one in a long task.
 * `loading` until they are in; `ready` at once when they already are, or when
 * there are no workers (the page builds each on first read, as before). A
 * shape a worker could not build is left to the page the same way.
 */
export function useIslandShapes(
  M: WorldModel | null,
  placement: Placement | null,
  workers = true,
): IslandShapes {
  const missing =
    M && placement
      ? islandsInPlay(M, placement).filter((I) => !I.plan.built())
      : [];
  const carve = M !== null && placement !== null && !homeCarveBuilt();
  const want = M
    ? `${M.seed}|${carve}|${missing.map((I) => I.id).join(",")}`
    : "";
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  if (error) throw error;
  const pending =
    workers &&
    bakeWorkersAvailable() &&
    (missing.length > 0 || carve) &&
    done !== want;

  useEffect(() => {
    if (!pending || !M) return;
    const lease = leaseBakePool();
    if (!lease) throw new Error("isle shapes: bake workers vanished");
    let live = true;
    const { pool } = lease;
    void Promise.all([
      carve
        ? pool.carve().then((g) => {
            if (g !== "failed") adoptHomeCarve(g);
          })
        : null,
      ...missing.map((I) =>
        pool.shape(M, I).then((d) => {
          if (d !== "failed") I.plan.restore(d);
        }),
      ),
    ]).then(
      () => {
        if (live) setDone(want);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      live = false;
      lease.release();
    };
    // `want` names exactly what the effect builds (`missing`, `carve`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, want, M]);

  return pending ? "loading" : "ready";
}
