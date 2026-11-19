import { useEffect, useMemo, useState } from "react";
import {
  placeResidents,
  type Placement,
  type Resident,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { bakeWorkersAvailable, leaseBakePool } from "./bake-pool";

/** The placement with every resident placed, or `loading` while a worker places them. */
export type PlacedResidents = Placement | "loading";

interface Inputs {
  readonly M: WorldModel;
  readonly stored: Placement;
  readonly residents: readonly Resident[];
}

/**
 * `placeResidents(M, stored, residents)`, run in a bake worker: on a first
 * visit every app is placed at once — hundreds of ms of site search on the
 * page's thread, in the render right after the click that opened the
 * island. The worker runs the same world code over the same shapes
 * (`islandsInPlay`, sent ahead), so its placement is the page's. Where
 * workers cannot run — or one could not — it is computed here, as before.
 * `null` until every input is there.
 */
export function usePlacedResidents(
  M: WorldModel | null,
  stored: Placement | null,
  residents: readonly Resident[] | null,
): PlacedResidents | null {
  const inputs = useMemo(
    (): Inputs | null =>
      M && stored && residents ? { M, stored, residents } : null,
    [M, stored, residents],
  );
  const workers = bakeWorkersAvailable();
  const onPage = useMemo(
    () =>
      inputs && !workers
        ? placeResidents(inputs.M, inputs.stored, inputs.residents)
        : null,
    [inputs, workers],
  );
  const [placed, setPlaced] = useState<{
    readonly for: Inputs;
    readonly placement: Placement;
  } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  if (error) throw error;

  useEffect(() => {
    if (!inputs || !workers) return;
    const lease = leaseBakePool();
    if (!lease) throw new Error("isle placement: bake workers vanished");
    let live = true;
    const { M: model, stored: from, residents: rs } = inputs;
    void lease.pool.place(model, from, rs).then(
      (out) => {
        if (!live) return;
        setPlaced({
          for: inputs,
          placement: out === "failed" ? placeResidents(model, from, rs) : out,
        });
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [inputs, workers]);

  if (!inputs) return null;
  if (onPage) return onPage;
  return placed?.for === inputs ? placed.placement : "loading";
}
