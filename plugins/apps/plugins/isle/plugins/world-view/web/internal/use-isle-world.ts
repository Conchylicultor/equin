import { useEffect, useMemo, useRef } from "react";
import { useListedApps, type ActiveApp } from "@plugins/apps-core/web";
import { appTileFill } from "@plugins/apps-core/plugins/app-icon/core";
import { useConfigResult } from "@plugins/config_v2/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  categoryOfSeed,
  kitBuilding,
  type BuildingSpec,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";
import { useIsleBuildings } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import {
  claimPlots,
  islePlots,
  placementOfRows,
  placementWrites,
  worldOfSeed,
} from "@plugins/apps/plugins/isle/plugins/plots/core";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";
import {
  WorldModel,
  placeResidents,
  residentOf,
  type Placement,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import {
  useIslandShapes,
  type IsleApp,
  type TimeOfDay,
} from "@plugins/apps/plugins/isle/plugins/renderer/web";
import {
  ambientMoodOf,
  type AmbientMood,
} from "@plugins/music/plugins/ambient/core";
import { fnv1a32 } from "@plugins/packages/plugins/string-hash/core";
import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import { isleConfig } from "../../core";
import { useIsleFonts } from "./fonts";
import { useGlyphImages } from "./glyphs";

/** A resident app: the app entry the launcher holds, and what the engine draws for it. */
export interface Resident {
  readonly entry: ActiveApp;
  readonly app: IsleApp;
}

export type IsleWorld =
  | { readonly kind: "loading"; readonly what: string }
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "ready";
      readonly world: string;
      readonly model: WorldModel;
      readonly placement: Placement;
      readonly residents: readonly Resident[];
      readonly time: TimeOfDay | "auto";
      readonly music: boolean;
      readonly mood: AmbientMood;
    };

const kits = new Map<string, BuildingSpec>();
/** An app's building: the one it contributes (`Isle.Building`), else a generated one per id and category. */
function buildingOf(
  bespoke: ReadonlyMap<string, BuildingSpec>,
  id: string,
  category: AppCategory,
): BuildingSpec {
  const own = bespoke.get(id);
  if (own) return own;
  const key = `${id}|${category}`;
  let s = kits.get(key);
  if (!s) kits.set(key, (s = kitBuilding({ id }, category)));
  return s;
}

const TIMES = ["auto", "day", "dusk", "night"] as const;
const timeOf = (v: string): TimeOfDay | "auto" => {
  const t = TIMES.find((x) => x === v);
  if (!t) throw new Error(`isle: unknown time of day "${v}"`);
  return t;
};

/**
 * Everything the island is drawn from, or what it is still waiting for: the
 * config (seed, time), the listed apps (the residents, in the rail's order),
 * the stored plots of this seed, every app's glyph and the canvas fonts. Apps
 * without a plot are placed by the pure world and claimed; the world shows as
 * loading until the claim's push comes back — the stored placement is what is
 * drawn, never a prediction of it. A failed claim is the world's `error`.
 */
export function useIsleWorld(): IsleWorld {
  const config = useConfigResult(isleConfig);
  const listed = useListedApps();
  const seed = foldResource(config, {
    ready: (c) => c.seed,
    loading: () => null,
    error: () => null,
  });
  const world = seed === null ? null : worldOfSeed(seed);
  const plots = useLive(islePlots, {
    where: world === null ? null : { world },
    select: placementOfRows,
  });
  const fonts = useIsleFonts();
  const apps = foldResource(listed, {
    ready: (d) => d,
    loading: () => null,
    error: () => null,
  });
  const entries = useMemo(
    () => (apps ?? []).filter((e) => e.app.id !== isleApp.id),
    [apps],
  );
  const buildings = useIsleBuildings();
  const glyphs = useGlyphImages(
    entries.map((e) => ({ id: e.app.id, icon: e.app.icon })),
  );
  const model = useMemo(
    () => (seed === null ? null : new WorldModel(seed)),
    [seed],
  );
  const residents = useMemo((): Resident[] | null => {
    if (glyphs.kind !== "ready" || buildings.kind !== "ready") return null;
    return entries.map((entry) => {
      const id = entry.app.id;
      const category = entry.app.category ?? categoryOfSeed(fnv1a32(id));
      const glyph = glyphs.glyphs.get(id);
      if (!glyph) throw new Error(`isle: no glyph for ${id}`);
      return {
        entry,
        app: {
          id,
          name: entry.app.name,
          category,
          hue: appTileFill(entry.icon, id),
          spec: buildingOf(buildings.byApp, id, category),
          glyph,
        },
      };
    });
  }, [entries, glyphs, buildings]);
  const stored = foldResource(plots, {
    ready: (p) => p,
    loading: () => null,
    error: () => null,
  });
  // the island shapes placing and drawing read, built in the bake workers first
  const shapes = useIslandShapes(model, stored);
  // the apps with no plot yet: placed by the pure world, claimed (first writer wins)
  const pending = useMemo(() => {
    if (!model || !residents || !stored || shapes !== "ready") return null;
    const rs = residents.map((r) => residentOf(r.app, r.app.spec));
    return placementWrites(stored, placeResidents(model, stored, rs));
  }, [model, residents, stored, shapes]);
  // A failed claim is the world's failure (below), shown by the pane's error
  // boundary with its Retry — never a toast over a title card that would wait
  // on "Building new houses" forever, since a placement read is claimed once.
  const claim = useEndpointMutation(claimPlots, {
    meta: { suppressError: true },
  });
  const claimed = useRef<string | null>(null);
  useEffect(() => {
    if (!pending?.length || world === null) return;
    // one claim per placement read: a stale answer is followed by the push that made it stale
    const sig = JSON.stringify(pending.map((w) => [w.plot.id, w.occupant]));
    if (claimed.current === sig) return;
    claimed.current = sig;
    // eslint-disable-next-line reactive-server-io/no-reactive-server-io -- idempotent by construction: a compare-and-set batch every tab computes alike; the first lands, the rest answer `stale` and write nothing
    claim.mutate({ body: { world, writes: pending } });
  }, [pending, world, claim]);

  const base = combineResources({ config, listed, plots });
  return foldResource(base, {
    loading: (): IsleWorld => ({ kind: "loading", what: "Reading the map" }),
    error: (error): IsleWorld => ({ kind: "error", error }),
    ready: (d): IsleWorld => {
      if (claim.error) return { kind: "error", error: claim.error };
      if (glyphs.kind === "error")
        return { kind: "error", error: glyphs.error };
      if (typeof fonts === "object")
        return { kind: "error", error: fonts.error };
      if (buildings.kind !== "ready")
        return { kind: "loading", what: "Raising the buildings" };
      if (!model || world === null || !residents || fonts !== "ready")
        return { kind: "loading", what: "Painting the signs" };
      if (shapes !== "ready")
        return { kind: "loading", what: "Shaping the islands" };
      if (pending?.length)
        return { kind: "loading", what: "Building new houses" };
      return {
        kind: "ready",
        world,
        model,
        placement: d.plots,
        residents,
        time: timeOf(d.config.time),
        music: d.config.music,
        mood: ambientMoodOf(d.config.mood),
      };
    },
  });
}
