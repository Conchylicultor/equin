// Which pose to show, decided from a character's state — every decision the
// prototype's draw() made before blitting, with no canvas and no clock: the
// same CharacterState always gives the same CharacterFrame.

import { LOOKS, type Look, type LookName } from "./looks";
import type { View } from "./figure";

/** World px walked per full walk cycle (two steps) at height 1. */
export const STRIDE = 30;
export const WALK_FRAMES = 16;
export const IDLE_FRAMES = 8;
/** The sprite box in world px; the origin (0, 0) of a pose is the feet. */
export const CHARACTER_BOX = { w: 40, h: 58, ox: 20, oy: 52 } as const;
/** Seconds a turn cross-fades between the old and the new view. */
export const TURN_SECONDS = 0.12;

export type CharacterView = View;

/** The facing reduced to what is drawn: a view, mirrored when it points left. */
export interface ViewFlip {
  readonly view: CharacterView;
  readonly flip: boolean;
}

/** The view the character left, and when the view last changed (the engine's clock, seconds). */
export interface TurnMemory {
  readonly from: ViewFlip;
  readonly at: number;
}

export interface CharacterState {
  readonly look: LookName;
  /** Radians; 0 faces right, π/2 faces the viewer. Default π/2. */
  readonly facing?: number;
  readonly walking: boolean;
  /** Carried for callers; the pose does not depend on it. */
  readonly speed?: number;
  /** The engine's clock, seconds. */
  readonly t: number;
  /** World px walked so far. */
  readonly phase?: number;
  /** Set while a turn is fading; see createTurnTracker. */
  readonly turn?: TurnMemory;
}

/** One cacheable pose (see poseKey). Mirroring is not part of it. */
export interface CharacterPose {
  readonly look: LookName;
  readonly view: CharacterView;
  readonly mode: "walk" | "idle";
  /** Walk: 0..WALK_FRAMES-1. Idle: 0..IDLE_FRAMES-1. */
  readonly frame: number;
  readonly blink: boolean;
  /** -1 / 0 / 1: where the eyes look (front and back views only). */
  readonly gaze: number;
}

/** A pose as it is blitted: mirrored or not, at an opacity. */
export interface CharacterLayer {
  readonly pose: CharacterPose;
  readonly flip: boolean;
  readonly alpha: number;
}

export interface CharacterFrame {
  readonly look: LookName;
  /** The pose being turned to (alpha = progress; 1 when not turning). */
  readonly to: CharacterLayer;
  /** The pose being turned from, fading out; null when not turning. Paint it first. */
  readonly from: CharacterLayer | null;
}

export function viewOf(facing: number): ViewFlip {
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  if (Math.abs(c) >= Math.abs(s) * 0.85) return { view: "side", flip: c < 0 };
  return { view: s > 0 ? "front" : "back", flip: false };
}

const DEFAULT_FACING = Math.PI / 2;

function hashStr(s: string): number {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return h / 1000;
}

/** The cacheable identity of a pose: equal keys paint identical pixels. */
export function poseKey(p: CharacterPose): string {
  return `${p.look}|${p.view}|${p.mode}|${p.frame}|${p.blink ? 1 : 0}|${p.gaze}`;
}

export function characterFrame(s: CharacterState): CharacterFrame {
  const look = s.look;
  const L: Look = LOOKS[look];
  const seed = hashStr(look);
  const v = viewOf(s.facing ?? DEFAULT_FACING);
  let pick: (view: CharacterView) => CharacterPose;
  if (s.walking) {
    const cyc =
      ((((s.phase ?? 0) / (STRIDE * L.h * (L.stride ?? 1))) % 1) + 1) % 1;
    const frame = Math.floor(cyc * WALK_FRAMES) % WALK_FRAMES;
    pick = (view) => ({
      look,
      view,
      mode: "walk",
      frame,
      blink: false,
      gaze: 0,
    });
  } else {
    const tt = s.t + seed * 10;
    const frame = Math.floor(((tt * 0.28) % 1) * IDLE_FRAMES);
    const blink = (tt + seed * 3) % 4.1 < 0.13;
    const gp = (tt * 0.09 + seed) % 1;
    const gaze = gp > 0.62 && gp < 0.7 ? -1 : gp > 0.82 && gp < 0.9 ? 1 : 0;
    pick = (view) => ({
      look,
      view,
      mode: "idle",
      frame,
      blink,
      gaze: view === "side" ? 0 : gaze,
    });
  }
  const to: CharacterLayer = { pose: pick(v.view), flip: v.flip, alpha: 1 };
  const turn = s.turn;
  const k =
    turn && s.t - turn.at < TURN_SECONDS ? (s.t - turn.at) / TURN_SECONDS : 1;
  if (turn && k < 1)
    return {
      look,
      from: { pose: pick(turn.from.view), flip: turn.from.flip, alpha: 1 - k },
      to: { ...to, alpha: k },
    };
  return { look, from: null, to };
}

/**
 * Remembers each look's last view, so a view change becomes a TurnMemory for
 * characterFrame. The prototype kept this per look (each look is one character
 * in the scene); the renderer owns one tracker.
 */
export function createTurnTracker(): {
  observe(
    look: LookName,
    facing: number | undefined,
    t: number,
  ): TurnMemory | undefined;
} {
  interface Seen {
    key: string;
    v: ViewFlip;
    prev: ViewFlip | null;
    at: number;
  }
  const seen = new Map<LookName, Seen>();
  return {
    observe(look, facing, t) {
      const name = look;
      const v = viewOf(facing ?? DEFAULT_FACING);
      const key = v.view + (v.flip ? "L" : "R");
      let st = seen.get(name);
      if (!st) {
        st = { key, v, prev: null, at: -1 };
        seen.set(name, st);
      }
      if (st.key !== key) {
        st.prev = st.v;
        st.key = key;
        st.v = v;
        st.at = t;
      }
      return st.prev ? { from: st.prev, at: st.at } : undefined;
    },
  };
}
