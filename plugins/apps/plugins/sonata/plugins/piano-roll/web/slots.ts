/**
 * The piano-roll's FX extension point. Visual effects (key-strike glow,
 * ripples, debris, …) are SUB-PLUGINS contributing here — the host renders
 * them generically (collection-consumer clean: it never names an effect), so
 * adding an effect is one new plugin with zero piano-roll edits.
 *
 * An effect is a HEADLESS React component: it renders nothing and instead
 * wires imperative Pixi objects into the {@link FxContext} inside an effect
 * (subscribe onNoteOn/onReset, register an onFrame updater, parent containers into
 * `layers`), with full teardown on unmount. Each contribution also carries its
 * own one-field `{ enabled }` config — the host gates mounting on it AND the
 * config auto-appears in the generic settings pane, so a new effect ships its
 * own toggle for free.
 */
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ComponentType } from "react";
import type { Container, Renderer } from "pixi.js";
import type { EmitterOptions, ParticleEmitter } from "./internal/fx/particles";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { BoolFieldDef } from "@plugins/fields/plugins/bool/plugins/config/core";
import type {
  Note,
  Projection,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * The shape every effect's config must take: exactly one `enabled` bool. The
 * host reads it generically (`useConfig(c.config).enabled`), so the type pins
 * the contract — an effect cannot register a config the host can't gate on.
 */
export type FxToggleConfig = ConfigDescriptor<{ enabled: BoolFieldDef }>;

/**
 * A note-on as seen by FX plugins. All values are render-ready: lane screen
 * pixels, resolved numeric colors, wall-clock duration. Fired by the scene's
 * onset tracker the same frame the note's onset crosses the now-line.
 */
export interface FxNoteEvent {
  note: Note;
  /** Left edge of the note's key column, lane screen px. */
  x: number;
  /** Key column width, lane screen px. */
  width: number;
  /** The now-line's screen y (lane bottom — where notes land). */
  laneY: number;
  /** Resolved track color (0xRRGGBB — undarkened, even for black keys). */
  color: number;
  /** Normalized velocity, 0..1. */
  velocity: number;
  /** True on the five accidental pitch classes (sharps/flats). */
  isAccidental: boolean;
  /** Wall-clock duration at the CURRENT tempo (authored / tempoScale). */
  durationSeconds: number;
}

/**
 * Everything an effect needs to paint: mount points, event streams, geometry
 * accessors, the per-frame updater hook/renderer, and a quality budget.
 *
 * `getProjection`/`getLaneSize` are ACCESSORS (not snapshots) on purpose: the
 * context object stays identity-stable across lane resizes, and effects read
 * the latest geometry per tick instead of closing over stale values.
 */
export interface FxContext {
  /**
   * FX mount points in the scene graph: `belowNotes` paints under the falling
   * notes (subtle ambience), `aboveNotes` paints over them (strikes, debris).
   * Both are SCREEN-SPACE (they do not scroll with the content).
   */
  layers: { belowNotes: Container; aboveNotes: Container };
  /** Subscribe to note-ons; returns the unsubscribe. */
  onNoteOn(cb: (e: FxNoteEvent) => void): () => void;
  /** Seek/jump/score-change — drop all in-flight state. Returns unsubscribe. */
  onReset(cb: () => void): () => void;
  /** The roll's published projection (content-space geometry, latest). */
  getProjection(): Projection;
  /** Lane size in CSS px (latest — re-read per tick, never cache). */
  getLaneSize(): { width: number; height: number };
  /**
   * The live playback cursor in quarter-note beats (latest — re-read per tick).
   *
   * The clock a NOTE-ANCHORED effect must read instead of integrating
   * wall-clock deltas: a highlight glued to a moving note (e.g. fx-core's
   * active-note brighten) derives its geometry as a pure function of (this
   * cursor, the note), so it stays welded to the bar by construction — paused
   * cursor ⇒ frozen highlight on the frozen bar, scrub ⇒ it follows. Wall-clock
   * integration desyncs the moment playback isn't advancing at real-time speed.
   *
   * TRANSIENT strike bursts (sparks, glow, ripples, debris) do NOT use this —
   * they spawn at the fixed now-line and play out a short wall-clock fade, with
   * no note to track; freezing those on pause would suspend particles mid-air.
   */
  getPlaybackBeats(): number;
  /**
   * Register a per-frame update; returns the unregister (call it on unmount).
   *
   * The roll renders ON DEMAND (no free-running ticker): frames run only while
   * something changes. `update(dtSec)` runs once per rendered frame and MUST
   * return whether the effect is still animating — true while particles are
   * alive / a fade is running, false once it has settled. The loop stays alive
   * exactly while any updater returns true, then stops; an effect never holds
   * it open by merely being mounted. Return `liveCount() > 0`-style truth, not
   * a constant `true`.
   *
   * Waking: the scene requests a frame on every note-on, reset, and cursor
   * change, BEFORE the updater next runs — so an effect spawned from
   * `onNoteOn` is always updated on that frame and keeps itself alive by
   * returning true. Anything driven by the playback cursor (see
   * `getPlaybackBeats`) is re-evaluated on every cursor change for free.
   */
  onFrame(update: (dtSec: number) => boolean): () => void;
  /** The live renderer (texture generation, DPR). */
  renderer: Renderer;
  /**
   * Build a pooled particle emitter parented into one of the `layers`. The host
   * owns the pixi coupling (this is piano-roll's own `createEmitter` factory),
   * so an effect never imports the factory itself — that keeps the pixi-bearing
   * particle pool out of the eager plugin-boot wave (the fx barrels are eager,
   * the pool is not). Size the pool with `quality.particleBudget`.
   */
  createEmitter(parent: Container, opts: EmitterOptions): ParticleEmitter;
  /**
   * Quality knobs. `particleBudget` is a per-pool capacity ceiling derived
   * from the lane area — size pools with it and let spawns drop when full so
   * effects degrade gracefully on small lanes instead of overdrawing.
   */
  quality: { particleBudget: number };
}

/**
 * One visual effect for the piano roll. `tier` groups the host's toggle UI
 * ("ambient" = subtle defaults, "fancy" = opt-in spectacle); `config` is the
 * effect's own `{ enabled }` descriptor (register it via ConfigV2 on both
 * runtimes); `component` is the headless wiring component.
 */
export const PianoRollFx = defineSlot<{
  id: string;
  label: string;
  icon?: IconRef;
  tier: "ambient" | "fancy";
  config: FxToggleConfig;
  component: ComponentType<{ fx: FxContext }>;
}>({ docLabel: (p) => p.label });
