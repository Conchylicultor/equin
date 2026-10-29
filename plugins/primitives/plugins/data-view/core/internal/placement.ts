import type { FieldKind } from "@plugins/fields/core";

/**
 * Where a field is drawn in a row — one vocabulary every view draws, so one
 * placement works in the list, the table, the tree and the gallery:
 *
 * | Slot | List / tree row | Table | Gallery card |
 * |---|---|---|---|
 * | `lead` | glyph / avatar / leading time | first column | cover badge |
 * | `title` | the label | title column | title |
 * | `afterTitle` | marks after the label | inline in the title cell | after the title |
 * | `line2` | the subtitle run | stacked under the title | subtitle |
 * | `trail` | aligned trailing slots | columns | the first three tokens |
 * | `edge` | far right, faint | last column | footer right |
 * | `hidden` | filter / sort / group only | same | same |
 */
export const SLOTS = [
  "lead",
  "title",
  "afterTitle",
  "line2",
  "trail",
  "edge",
  "hidden",
] as const;
export type Slot = (typeof SLOTS)[number];

/** The form a value takes in a slot (`FieldCell`'s `context`): its cell, its
 *  short token form, or a state's glyph alone. */
export type SlotForm = "cell" | "token" | "glyph";

/** How a view draws one slot. */
export interface SlotSpec {
  /** How many fields it holds. Default: any number. */
  capacity?: number;
  /** The form its values take. Default `"cell"`. */
  form?: SlotForm;
  /** The only kinds it takes (an icon tile's face is a visual). Default: any. */
  kinds?: readonly FieldKind[];
}

/**
 * The slots a view draws, as data — what the placement engine places into.
 * A slot the view leaves out is one it does not draw: a recipe rule into it
 * falls through to the field's next rule, as it does for a full slot. The
 * Properties slot editor offers exactly these. (`hidden` is every view's.)
 */
export type ViewSlots = Readonly<
  Partial<Record<Exclude<Slot, "hidden">, SlotSpec>>
>;

/**
 * Which slots matter most — what gives way LAST when a view is narrow. A
 * field's priority is its slot's rank, then its drawing order in the slot;
 * a surface's `emphasis` comes before all of it. Never the recipe's rule
 * order: reordering rules to change who wins a slot must not change what
 * drops first.
 */
export const SLOT_RANK: readonly Exclude<Slot, "hidden">[] = [
  "title",
  "lead",
  "edge",
  "afterTitle",
  "line2",
  "trail",
];

/** What a recipe rule matches: a field kind, or the row's identity (`primary`). */
export type PlacementMatch = FieldKind | "identity";

/** One recipe rule: place an unplaced field matching `match` into `slot`. */
export type RecipeRule = readonly [match: PlacementMatch, slot: Slot];

const TRAIL_REST = [
  ["label", "trail"],
  ["person", "trail"],
  ["ordinal", "trail"],
  ["quantity", "trail"],
  ["duration", "trail"],
  ["path", "trail"],
] as const satisfies readonly RecipeRule[];

/**
 * Where each kind goes, per kind of surface — ordered rules, walked by the
 * placement engine rule by rule (a field takes the first matching rule whose
 * slot has room, so a second instant falls through to its next rule). Plain
 * data: a recipe is one word on the surface.
 *
 * - `record` (the default) — identity → title, state → lead, instant → edge,
 *   prose / identifier → line 2, the rest trailing.
 *
 * Only the first state leads; every other one TRAILS (never `afterTitle`,
 * outside `log`): a coloured enum — a priority, a category — is a state too,
 * and drawn after a title of varying length it lands at a different x on
 * every row. `afterTitle` is for a surface's own pins (a problem badge).
 * - `log` — the time leads, the identity is the title, no line 2.
 * - `timeline` — state leads; time, person and prose on line 2.
 * - `inbox` — a person is the title, the identity drops to line 2.
 * - `ledger` — state leads, one instant at the edge, extra instants hidden.
 */
export const RECIPES = {
  record: [
    ["identity", "title"],
    ["state", "lead"],
    ["visual", "lead"],
    ["flag", "afterTitle"],
    ["instant", "edge"],
    ["prose", "line2"],
    ["identifier", "line2"],
    ...TRAIL_REST,
    ["instant", "trail"],
    ["visual", "trail"],
    ["state", "trail"],
  ],
  log: [
    ["instant", "lead"],
    ["identity", "title"],
    ["state", "afterTitle"],
    ["flag", "afterTitle"],
    ["label", "trail"],
    ["identifier", "trail"],
    ["ordinal", "trail"],
    ["quantity", "trail"],
    ["duration", "trail"],
    ["person", "trail"],
    ["path", "trail"],
    ["prose", "trail"],
    ["instant", "trail"],
    ["visual", "trail"],
    ["state", "trail"],
  ],
  timeline: [
    ["state", "lead"],
    ["visual", "lead"],
    ["identity", "title"],
    ["flag", "afterTitle"],
    ["instant", "line2"],
    ["person", "line2"],
    ["prose", "line2"],
    ["identifier", "trail"],
    ["label", "trail"],
    ["ordinal", "trail"],
    ["quantity", "trail"],
    ["duration", "trail"],
    ["path", "trail"],
    ["instant", "hidden"],
    ["state", "trail"],
  ],
  inbox: [
    ["person", "title"],
    ["identity", "title"],
    ["identity", "line2"],
    ["visual", "lead"],
    ["state", "lead"],
    ["flag", "afterTitle"],
    ["instant", "edge"],
    ["prose", "line2"],
    ["label", "trail"],
    ["identifier", "trail"],
    ["ordinal", "trail"],
    ["quantity", "trail"],
    ["duration", "trail"],
    ["path", "trail"],
    ["person", "trail"],
    ["instant", "hidden"],
    ["state", "trail"],
  ],
  ledger: [
    ["state", "lead"],
    ["identity", "title"],
    ["prose", "line2"],
    ["flag", "afterTitle"],
    ["instant", "edge"],
    ["identifier", "trail"],
    ["label", "trail"],
    ["person", "trail"],
    ["ordinal", "trail"],
    ["quantity", "trail"],
    ["duration", "trail"],
    ["path", "trail"],
    ["visual", "lead"],
    ["state", "trail"],
    ["instant", "hidden"],
  ],
} as const satisfies Record<string, readonly RecipeRule[]>;

export type Recipe = keyof typeof RECIPES;

/**
 * A surface's say in where its fields go — every key optional, each saying
 * only what it changes. A field's slot is the most specific layer that sets
 * it: its kind under the recipe, then `place`, then the user's own
 * (`PropertyEntry.slot`).
 */
export interface PlacementSpec {
  /** The kind of surface. Default `record`. */
  recipe?: Recipe;
  /**
   * Pin a field to a slot, by field id — where the recipe is wrong for this
   * surface (`{ updatedAt: "edge" }`: which instant is the row's). A pin wins
   * over the recipe, even on a slot that holds one. An unknown id throws.
   */
  place?: Readonly<Record<string, Slot>>;
  /**
   * Fields that never give way first, in order: they move to the front of the
   * priority order (their slot unchanged). For a surface with several equal
   * measures only it can rank (a cost table's cost). An unknown id throws.
   */
  emphasis?: readonly string[];
}
