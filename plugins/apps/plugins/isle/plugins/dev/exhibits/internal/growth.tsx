import { useEffect, useMemo, useRef, useState } from "react";
import { mulberry32 } from "@plugins/packages/plugins/seeded-random/core";
import {
  APP_CATEGORIES,
  type AppCategory,
} from "@plugins/primitives/plugins/pane/core";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { kitBuilding } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import {
  EMPTY_PLACEMENT,
  WorldModel,
  applyMove,
  layoutWorld,
  placeResidents,
  residentOf,
  type MoveTarget,
  type Placement,
  type Resident,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  IsleEngine,
  useIslandShapes,
  type IsleApp,
} from "@plugins/apps/plugins/isle/plugins/renderer/web";
import { FAKE_APPS, MAX_APPS, MIN_APPS, type FakeApp } from "./fake-apps";
import "./growth.css";

/** A made-up app's sign glyph: its initial, white on transparent. */
function initialGlyph(name: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) throw new Error("isle growth: no 2D context");
  g.fillStyle = "#ffffff";
  g.font = "700 44px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(name.slice(0, 1).toUpperCase(), 32, 34);
  return c;
}

const drawn = new Map<string, IsleApp>();
/** A made-up app as the engine draws it (a generated building), once per id. */
function isleAppOf(a: FakeApp): IsleApp {
  let x = drawn.get(a.id);
  if (!x) {
    x = {
      id: a.id,
      name: a.name,
      category: a.category,
      hue: a.hue,
      spec: kitBuilding({ id: a.id }, a.category),
      glyph: initialGlyph(a.name),
    };
    drawn.set(a.id, x);
  }
  return x;
}
const residentsOf = (apps: readonly FakeApp[]): Resident[] =>
  apps.map((a) => residentOf(a, isleAppOf(a).spec));

interface World {
  readonly seed: number;
  readonly apps: readonly FakeApp[];
  /** In memory only: placed append-only, as the real plots are — never written. */
  readonly placement: Placement;
  /** How long placing and laying the world out took, ms. */
  readonly rebuildMs: number;
  /** Bumped by Rebuild: a fresh model and engine, nothing baked. */
  readonly generation: number;
}

/** The world with `apps` placed on `placement` (append-only), timed. */
function grow(
  seed: number,
  placer: WorldModel,
  placement: Placement,
  apps: readonly FakeApp[],
  generation: number,
): World {
  const t0 = performance.now();
  const rs = residentsOf(apps);
  const next = placeResidents(placer, placement, rs);
  layoutWorld(placer, next, rs);
  return {
    seed,
    apps,
    placement: next,
    rebuildMs: performance.now() - t0,
    generation,
  };
}

/** The island at N made-up apps: grow and shrink it, change its seed, and compare baking in workers with the page. */
export default function IsleGrowth() {
  const [placer, setPlacer] = useState(() => new WorldModel(1));
  const [world, setWorld] = useState<World>(() =>
    grow(1, placer, EMPTY_PLACEMENT, FAKE_APPS.slice(0, MIN_APPS), 0),
  );
  const [workers, setWorkers] = useState(true);
  const [countText, setCountText] = useState(String(MIN_APPS));
  const [removed, setRemoved] = useState(0);
  const [digest, setDigest] = useState<string | null>(null);
  const [readyAt, setReadyAt] = useState(0);
  const [rebuiltAt, setRebuiltAt] = useState(0);

  // the model drawn: fresh per rebuild (no shape built), so a rebuild bakes from scratch
  const model = useMemo(
    () => new WorldModel(world.seed),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new model exactly per seed and rebuild
    [world.seed, world.generation],
  );
  const shapes = useIslandShapes(model, world.placement, workers);

  const setApps = (apps: readonly FakeApp[]) =>
    setWorld((w) => grow(w.seed, placer, w.placement, apps, w.generation));
  const setCount = (n: number) => {
    const k = Math.max(MIN_APPS, Math.min(MAX_APPS, Math.round(n)));
    setCountText(String(k));
    setApps(FAKE_APPS.slice(0, k));
  };
  const addTo = (c: AppCategory) => {
    const have = new Set(world.apps.map((a) => a.id));
    const next = FAKE_APPS.find((a) => a.category === c && !have.has(a.id));
    if (next) setApps([...world.apps, next]);
  };
  const removeRandom = () => {
    if (world.apps.length <= 1) return;
    const r = mulberry32(world.seed * 7919 + removed)();
    const i = Math.floor(r * world.apps.length);
    setRemoved(removed + 1);
    setApps(world.apps.filter((_, k) => k !== i));
  };
  const reseed = (seed: number) => {
    const next = new WorldModel(seed);
    setPlacer(next);
    setWorld((w) =>
      grow(seed, next, EMPTY_PLACEMENT, w.apps, w.generation + 1),
    );
  };
  const rebuild = () => {
    setDigest(null);
    setRebuiltAt(performance.now());
    setWorld((w) => ({ ...w, generation: w.generation + 1 }));
  };

  const stats = useMemo(() => {
    const L = layoutWorld(placer, world.placement, residentsOf(world.apps));
    const districts = Object.values(world.placement.plots).filter(
      (ps) => ps.length > 0,
    ).length;
    const plots = Object.values(world.placement.plots).reduce(
      (n, ps) => n + ps.length,
      0,
    );
    return {
      islands: L.islands.length,
      districts,
      buildings: L.buildings.length,
      lots: plots - L.buildings.length,
    };
  }, [placer, world]);

  return (
    <Stack direction="col" gap="sm" className="p-md">
      <Stack direction="row" gap="sm" align="center" wrap>
        <Stack direction="row" gap="xs" align="center">
          Apps
          <Input
            aria-label="Apps"
            type="number"
            min={MIN_APPS}
            max={MAX_APPS}
            className="w-20"
            value={countText}
            onChange={(e) => setCountText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setCount(Number(countText));
            }}
            onBlur={() => setCount(Number(countText))}
          />
        </Stack>
        <input
          aria-label="App count"
          type="range"
          min={MIN_APPS}
          max={MAX_APPS}
          value={world.apps.length}
          onChange={(e) => setCount(Number(e.target.value))}
        />
        <Button
          variant="outline"
          onClick={() => setCount(world.apps.length - 1)}
        >
          −1
        </Button>
        <Button
          variant="outline"
          onClick={() => setCount(world.apps.length + 1)}
        >
          +1
        </Button>
        {APP_CATEGORIES.map((c) => (
          <Button key={c} variant="outline" onClick={() => addTo(c)}>
            + {c}
          </Button>
        ))}
        <Button variant="outline" onClick={removeRandom}>
          Remove random
        </Button>
        <Stack direction="row" gap="xs" align="center">
          Seed
          <Input
            aria-label="Seed"
            type="number"
            className="w-20"
            defaultValue={world.seed}
            onKeyDown={(e) => {
              if (e.key === "Enter") reseed(Number(e.currentTarget.value) || 1);
            }}
          />
        </Stack>
        <Button variant="outline" onClick={() => setWorkers(!workers)}>
          Bake: {workers ? "workers" : "page"}
        </Button>
        <Button onClick={rebuild}>Rebuild</Button>
      </Stack>
      <Stack direction="row" gap="md" align="center" wrap>
        <span>
          {stats.islands} islands · {stats.districts} districts ·{" "}
          {stats.buildings} buildings · {stats.lots} empty lots · placed in{" "}
          {world.rebuildMs.toFixed(0)} ms
          {readyAt > rebuiltAt && rebuiltAt > 0
            ? ` · drawn ${(readyAt - rebuiltAt).toFixed(0)} ms after Rebuild`
            : ""}
        </span>
      </Stack>
      <div
        className="isle-growth-frame"
        data-isle-ready={readyAt || undefined}
        data-isle-rebuilt={rebuiltAt || undefined}
      >
        {shapes === "ready" ? (
          <GrowthCanvas
            key={`${world.seed}:${world.generation}:${workers}`}
            model={model}
            world={world}
            workers={workers}
            onReady={() => setReadyAt(performance.now())}
            onDigest={setDigest}
            onMove={(placement) => setWorld((w) => ({ ...w, placement }))}
          />
        ) : (
          <span className="isle-growth-wait">Shaping the islands…</span>
        )}
      </div>
      {digest !== null ? (
        <pre data-isle-digest className="isle-growth-digest-text">
          {digest}
        </pre>
      ) : null}
    </Stack>
  );
}

function GrowthCanvas(props: {
  model: WorldModel;
  world: World;
  workers: boolean;
  onReady(): void;
  onDigest(d: string): void;
  onMove(placement: Placement): void;
}) {
  const { model, world, workers } = props;
  const [measure, size] = useElementSize<HTMLDivElement>();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<IsleEngine | null>(null);
  // as the app's title card does: input begins once the world is drawn
  const onReady = useEventCallback(() => {
    engineRef.current?.start();
    props.onReady();
  });
  const onMove = useEventCallback((appId: string, target: MoveTarget) =>
    props.onMove(
      applyMove(model, world.placement, residentsOf(world.apps), appId, target),
    ),
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) throw new Error("isle growth: stage not mounted");
    const engine = new IsleEngine(
      stage,
      {
        onReady,
        onNear: () => {},
        onEnter: () => {},
        onMove,
        onWhere: () => {},
        onStep: () => {},
        onHover: () => {},
      },
      { reducedMotion: false, workers },
    );
    engine.setTime("day");
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.dispose();
    };
  }, [model, workers, onReady, onMove]);

  useEffect(() => {
    engineRef.current?.setWorld(
      model,
      world.placement,
      world.apps.map(isleAppOf),
    );
  }, [model, world]);

  useEffect(() => engineRef.current?.resize(size.width, size.height), [size]);

  return (
    <>
      <div
        ref={(el) => {
          stageRef.current = el;
          measure(el);
        }}
        className="isle-growth-stage"
      />
      <Button
        variant="outline"
        className="isle-growth-digest"
        onClick={() => {
          const d = engineRef.current?.bakedDigest();
          if (d) props.onDigest(JSON.stringify(d, null, 1));
        }}
      >
        Digest
      </Button>
    </>
  );
}
