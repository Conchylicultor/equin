/**
 * Builds the {@link FxContext} handed to every FX contribution — the bridge
 * between the live scene/app pair and the effect plugins' headless components.
 *
 * Built ONCE per scene (identity-stable across resizes): geometry and the
 * playback cursor flow through the `getProjection`/`getLaneSize`/
 * `getPlaybackBeats` ACCESSORS — the host wires the first two to refs holding
 * the latest values and the last to the shared cursor store — so effects
 * always read current values per tick without the context object ever changing
 * identity (which would force a full effect remount on every lane resize).
 *
 * PARTICLE BUDGET: exposed as a live getter computed from the CURRENT lane
 * area — `min(2000, laneW·laneH / 400)`, floored at 256. The getter (rather
 * than a value snapshotted at build time or mutated on resize) means a read is
 * never stale by construction. Effects read it once at mount to size their
 * fixed-capacity pools; the floor guards the mount-before-first-layout window
 * where the lane still measures 0×0 (a 0-capacity pool would silently disable
 * the effect forever). A later resize doesn't re-size existing pools — pool
 * capacity is a ceiling, and spawns dropping at the old ceiling is acceptable
 * degradation (documented contract on FxContext.quality).
 */
import type { Application } from "pixi.js";
import type { Projection } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { FxContext } from "../../slots";
import type { PianoRollScene } from "../pixi/scene";
import { createEmitter } from "./particles";

/** Global ceiling — even a huge lane never buys more than this per pool. */
const PARTICLE_BUDGET_MAX = 2000;
/** Floor — keeps effects alive on tiny lanes and pre-layout 0×0 reads. */
const PARTICLE_BUDGET_MIN = 256;
/** Lane px² per particle: 1 particle of budget per 400 px² of lane. */
const AREA_PER_PARTICLE = 400;

export function createFxContext(input: {
  scene: PianoRollScene;
  app: Application;
  getProjection: () => Projection;
  getLaneSize: () => { width: number; height: number };
  getPlaybackBeats: () => number;
}): FxContext {
  const { scene, app, getProjection, getLaneSize, getPlaybackBeats } = input;
  return {
    layers: scene.fxLayers,
    // Wrapped (not passed bare) so the context never depends on the scene
    // methods being safely unbound.
    onNoteOn: (cb) => scene.onNoteOn(cb),
    onReset: (cb) => scene.onReset(cb),
    getProjection,
    getLaneSize,
    getPlaybackBeats,
    onFrame: (update) => scene.onFrame(update),
    renderer: app.renderer,
    createEmitter,
    quality: {
      get particleBudget(): number {
        const { width, height } = getLaneSize();
        return Math.max(
          PARTICLE_BUDGET_MIN,
          Math.min(
            PARTICLE_BUDGET_MAX,
            Math.round((width * height) / AREA_PER_PARTICLE),
          ),
        );
      },
    },
  };
}
