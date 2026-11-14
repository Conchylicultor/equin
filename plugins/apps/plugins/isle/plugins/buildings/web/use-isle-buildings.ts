import { useMemo } from "react";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import type { BuildingSpec } from "../core";
import { Isle } from "./slots";

/**
 * Every contributed building, by app id — or `loading` while the deferred
 * plugin tier (where every `isle-building` sub-plugin lives) is still loading:
 * placement sizes a plot from the building, so an app must never be placed
 * with the generated stand-in of a building that has not arrived yet.
 * Two buildings for one app throw.
 */
export function useIsleBuildings():
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly byApp: ReadonlyMap<string, BuildingSpec>;
    } {
  const settled = useDeferredLoadComplete();
  const contributions = Isle.Building.useContributions();
  const byApp = useMemo(() => {
    const m = new Map<string, BuildingSpec>();
    for (const c of contributions) {
      if (m.has(c.app.id))
        throw new Error(
          `Isle.Building: two buildings contributed for app "${c.app.id}"`,
        );
      m.set(c.app.id, c.building);
    }
    return m;
  }, [contributions]);
  return useMemo(
    () => (settled ? { kind: "ready", byApp } : { kind: "loading" }),
    [settled, byApp],
  );
}
