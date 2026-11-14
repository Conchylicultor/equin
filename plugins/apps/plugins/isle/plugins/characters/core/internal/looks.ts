// The cast: one Look per character — proportions, colours and the few props
// that tell them apart. Numbers are the prototype's.

export type HairStyle = "curly" | "cap" | "bun" | "bald" | "short" | "swept";

interface LookBase {
  readonly name: string;
  /** Height factor (1 = the reference figure). */
  readonly h: number;
  /** Width factor. */
  readonly w: number;
  /** Head size factor. */
  readonly head: number;
  readonly skin: string;
  readonly hair: string;
  readonly top: string;
  readonly bottom: string;
  readonly shoe: string;
  /** Forward lean of the torso, rad. */
  readonly lean: number;
  /** Arm swing factor. */
  readonly swing: number;
  /** Leg stride factor (default 1). */
  readonly stride?: number;
  readonly sleeve?: "short" | "rolled";
  readonly beard?: string;
  readonly coat?: boolean;
  readonly skirt?: string;
  readonly shawl?: string;
  readonly apron?: string;
  readonly satchel?: string;
  readonly basket?: boolean;
  readonly cane?: boolean;
}

/** A cap look carries its cap colour; no other style may. */
export type Look = LookBase &
  (
    | { readonly hairStyle: "cap"; readonly cap: string }
    | {
        readonly hairStyle: Exclude<HairStyle, "cap">;
        readonly cap?: undefined;
      }
  );

export const LOOKS = {
  hero: {
    name: "hero",
    h: 0.9,
    w: 0.92,
    head: 1.12,
    skin: "#e2b28c",
    hair: "#3b2a1f",
    hairStyle: "curly",
    top: "#c26f35",
    sleeve: "short",
    bottom: "#4d6283",
    shoe: "#5b3f2b",
    lean: 0.06,
    swing: 1.05,
  },
  villager1: {
    name: "fisherman",
    h: 1.02,
    w: 1.14,
    head: 1,
    skin: "#d6a37f",
    hair: "#8d8780",
    hairStyle: "cap",
    cap: "#3d4856",
    beard: "#9a948c",
    top: "#a68c45",
    coat: true,
    bottom: "#3e3c38",
    shoe: "#2e2a26",
    lean: 0.07,
    swing: 0.8,
  },
  villager2: {
    name: "basket woman",
    h: 0.97,
    w: 0.95,
    head: 1,
    skin: "#e7bf9c",
    hair: "#7a3f24",
    hairStyle: "bun",
    top: "#7c5868",
    skirt: "#6a4b58",
    shawl: "#a8946e",
    bottom: "#4a3a34",
    shoe: "#3a2d26",
    basket: true,
    lean: 0.05,
    swing: 0.55,
  },
  villager3: {
    name: "elder",
    h: 0.94,
    w: 0.98,
    head: 1,
    skin: "#d8ab88",
    hair: "#e4e0d8",
    hairStyle: "bald",
    beard: "#ddd8cf",
    top: "#66705e",
    coat: true,
    bottom: "#55524a",
    shoe: "#3a332b",
    cane: true,
    lean: 0.2,
    swing: 0.45,
    stride: 0.75,
  },
  villager4: {
    name: "blacksmith",
    h: 1.05,
    w: 1.24,
    head: 1,
    skin: "#c99572",
    hair: "#2a2420",
    hairStyle: "short",
    beard: "#2f2620",
    top: "#cdc2a6",
    sleeve: "rolled",
    apron: "#6b4a31",
    bottom: "#3f3a33",
    shoe: "#2b2520",
    lean: 0.05,
    swing: 0.85,
  },
  villager5: {
    name: "young courier",
    h: 0.96,
    w: 0.88,
    head: 1.02,
    skin: "#efc9a6",
    hair: "#c4a065",
    hairStyle: "swept",
    top: "#4f6d69",
    bottom: "#8a7c5c",
    shoe: "#4a3a2c",
    satchel: "#7a5a3a",
    lean: 0.07,
    swing: 1,
  },
} as const satisfies Record<string, Look>;

export type LookName = keyof typeof LOOKS;

export const LOOK_NAMES = Object.keys(LOOKS) as readonly LookName[];

export function isLookName(name: string): name is LookName {
  return Object.hasOwn(LOOKS, name);
}
