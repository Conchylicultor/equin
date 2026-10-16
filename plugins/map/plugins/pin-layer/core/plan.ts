/**
 * What the map draws for its pins at one zoom, as data: one item per mark —
 * a pin (near or far, a spot's lead told the spot's size) or a cluster — with
 * its stacking. Pure: the renderer hands in each pin's world position at the
 * zoom; the plan changes only when the zoom, the pins, the crowd mode, the
 * selection or the hovered pin does — never on a pan.
 */
import {
  clusterPins,
  groupSpots,
  pinStackOrder,
  type ClusterPoint,
  type LatLng,
  type MapCrowd,
  type MapPin,
  type SpotPoint,
} from "@plugins/map/core";

/** A pin's position in world pixels at the planned zoom (the projection's 256-px world × 2^zoom). */
export type WorldPoint = (pin: MapPin) => { x: number; y: number };

export type PlannedItem =
  | {
      kind: "pin";
      /** The pin's id. */
      id: string;
      pin: MapPin;
      scale: "near" | "far";
      /** Stacking: a higher item draws above a lower one (and wins a hit). */
      z: number;
      /** Set only on the lead of a far spot of more than one pin. */
      spot?: { count: number; hushed: boolean };
    }
  | {
      kind: "cluster";
      /** `cluster:<seed id>` — stable while the cluster keeps its seed. */
      id: string;
      /** Never fewer than two; the seed first. */
      pins: readonly MapPin[];
      /** The members' mean position — where the cluster mark sits. */
      position: LatLng;
      z: number;
    };

export interface PlanInput {
  pins: readonly MapPin[];
  /** Absent: every pin on its own, near. */
  crowd: MapCrowd | undefined;
  zoom: number;
  world: WorldPoint;
  activeId: string | null;
  /** The pin under the pointer: hushes its spot's count. */
  hoveredId: string | null;
}

/** Outranks any `MapPin.rank`: the selection always leads its spot. */
const ACTIVE_RANK = Number.MAX_SAFE_INTEGER;

/** The cluster item id of a cluster seeded by `seedId`. */
export function clusterItemId(seedId: string): string {
  return `cluster:${seedId}`;
}

export function planPins(input: PlanInput): PlannedItem[] {
  const { pins, crowd, activeId } = input;
  const stack = pinStackOrder(pins, activeId);
  const z = (id: string) => stack.get(id) ?? 1;
  if (crowd === undefined) {
    return pins.map((pin) => ({
      kind: "pin",
      id: pin.id,
      pin,
      scale: "near",
      z: z(pin.id),
    }));
  }
  return crowd.kind === "spots"
    ? planSpots(input, crowd.radiusPx, crowd.nearZoom, z)
    : planClusters(input, crowd.radiusPx, z);
}

function planSpots(
  { pins, zoom, world, activeId, hoveredId }: PlanInput,
  radiusPx: number,
  nearZoom: number,
  z: (id: string) => number,
): PlannedItem[] {
  if (zoom >= nearZoom) {
    return pins.map((pin) => ({
      kind: "pin",
      id: pin.id,
      pin,
      scale: "near",
      // The active pin draws above everything, as its stack order already says.
      z: z(pin.id) + (pin.id === activeId ? 2 * pins.length : 0),
    }));
  }
  const points: SpotPoint[] = pins.map((pin) => ({
    id: pin.id,
    ...world(pin),
    rank: pin.id === activeId ? ACTIVE_RANK : (pin.rank ?? 0),
  }));
  const sizeOf = new Map<string, number>();
  const hushedLead = new Set<string>();
  for (const spot of groupSpots(points, radiusPx)) {
    sizeOf.set(spot.lead, spot.ids.length);
    if (hoveredId !== null && spot.ids.includes(hoveredId)) {
      hushedLead.add(spot.lead);
    }
  }
  return pins.map((pin) => {
    const size = sizeOf.get(pin.id) ?? 1;
    const active = pin.id === activeId;
    // A counting lead draws above every pin that is not one, so its count is
    // never buried; the active pin above everything.
    const lift = active ? 2 * pins.length : size > 1 ? pins.length : 0;
    return {
      kind: "pin",
      id: pin.id,
      pin,
      scale: "far",
      z: z(pin.id) + lift,
      ...(size > 1
        ? { spot: { count: size, hushed: hushedLead.has(pin.id) } }
        : {}),
    };
  });
}

function planClusters(
  { pins, world, activeId }: PlanInput,
  radiusPx: number,
  z: (id: string) => number,
): PlannedItem[] {
  const byId = new Map(pins.map((p) => [p.id, p]));
  const points: ClusterPoint[] = [];
  for (const pin of pins) {
    // The selection is always its own pin, never inside a cluster.
    if (pin.id !== activeId) points.push({ id: pin.id, ...world(pin) });
  }
  const out: PlannedItem[] = [];
  for (const group of clusterPins(points, radiusPx)) {
    const members = group.ids.map((id) => {
      const pin = byId.get(id);
      if (pin === undefined) throw new Error(`Unknown clustered pin ${id}`);
      return pin;
    });
    const [seed] = members;
    if (seed === undefined) throw new Error("Empty pin cluster");
    out.push(
      members.length === 1
        ? { kind: "pin", id: seed.id, pin: seed, scale: "near", z: z(seed.id) }
        : {
            kind: "cluster",
            id: clusterItemId(seed.id),
            pins: members,
            position: centroid(members),
            z: z(seed.id),
          },
    );
  }
  const active = activeId === null ? undefined : byId.get(activeId);
  if (active !== undefined) {
    out.push({
      kind: "pin",
      id: active.id,
      pin: active,
      scale: "near",
      z: z(active.id),
    });
  }
  return out;
}

function centroid(members: readonly MapPin[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const m of members) {
    lat += m.position.lat;
    lng += m.position.lng;
  }
  return { lat: lat / members.length, lng: lng / members.length };
}

/** A drawn item's box on screen, in container px. */
export interface HitBox {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  z: number;
}

/**
 * The topmost box containing `(x, y)` — the item a press there lands on —
 * or `null`. Ties on `z` go to the later box (drawn last, so on top).
 */
export function hitTest(
  boxes: readonly HitBox[],
  x: number,
  y: number,
): HitBox | null {
  let best: HitBox | null = null;
  for (const b of boxes) {
    if (
      x >= b.left &&
      x < b.left + b.width &&
      y >= b.top &&
      y < b.top + b.height &&
      (best === null || b.z >= best.z)
    ) {
      best = b;
    }
  }
  return best;
}
