// The people on the map: the hero and the villagers, drawn from
// characters/core's poses — each pose rendered once into a sprite at 3× and
// cached, blitted mirrored for left-facing side views, cross-faded on a turn.

import {
  CHARACTER_BOX,
  characterFrame,
  createTurnTracker,
  paintCharacterPose,
  paintCharacterShadow,
  poseKey,
  type CharacterLayer,
  type LookName,
} from "@plugins/apps/plugins/isle/plugins/characters/core";
import type { Pt } from "@plugins/apps/plugins/isle/plugins/world/core";
import { canvas, ctx2d, type Ctx } from "./kit";

/** Someone walking about. */
export interface Walker {
  look: LookName;
  x: number;
  y: number;
  /** Radians; 0 faces right, π/2 faces the viewer. */
  facing: number;
  walking: boolean;
  speed: number;
  /** World px walked so far. */
  phase: number;
}

export interface Hero extends Walker {
  path: Pt[] | null;
  stepAt: number;
  placed: boolean;
}

export interface Villager extends Walker {
  route: readonly Pt[] | null;
  routeKey: string | null;
  k: number;
  dir: 1 | -1;
  wait: number;
  /** Where it stands by a lived-in building's door, instead of walking a route. */
  linger: { readonly x: number; readonly y: number } | null;
}

const SC = 3;

/** Poses rendered once each (per look / view / frame), and who was facing where. */
export class People {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly turns = createTurnTracker();

  private sprite(layer: CharacterLayer): HTMLCanvasElement {
    const key = poseKey(layer.pose);
    let c = this.cache.get(key);
    if (c) return c;
    const B = CHARACTER_BOX;
    c = canvas(B.w * SC, B.h * SC);
    const g = ctx2d(c);
    g.setTransform(SC, 0, 0, SC, B.ox * SC, B.oy * SC);
    paintCharacterPose(g, layer.pose);
    this.cache.set(key, c);
    return c;
  }

  private blit(g: Ctx, x: number, y: number, layer: CharacterLayer): void {
    const B = CHARACTER_BOX;
    g.save();
    g.globalAlpha *= layer.alpha;
    g.translate(x, y);
    if (layer.flip) g.scale(-1, 1);
    g.drawImage(this.sprite(layer), -B.ox, -B.oy, B.w, B.h);
    g.restore();
  }

  draw(g: Ctx, p: Walker, t: number): void {
    const turn = this.turns.observe(p.look, p.facing, t);
    g.save();
    g.translate(p.x, p.y);
    paintCharacterShadow(g, p.look);
    g.restore();
    const f = characterFrame({
      look: p.look,
      facing: p.facing,
      walking: p.walking,
      speed: p.speed,
      t,
      phase: p.phase,
      ...(turn && { turn }),
    });
    if (f.from) this.blit(g, p.x, p.y, f.from);
    this.blit(g, p.x, p.y, f.to);
  }
}

/** A person's box round its feet (the sprite's, a few px wider). */
export const PBOX = [-24, -58, 24, 10] as const;
