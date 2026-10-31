import type { FieldKind } from "@plugins/fields/core";
import {
  RECIPES,
  SLOTS,
  SLOT_RANK,
  orderFieldsBySection,
  type FieldDef,
  type PlacementSpec,
  type PropertyEntry,
  type Slot,
  type SlotForm,
  type ViewSlots,
} from "../../core";

/** Every slot, each holding its fields in drawing order. */
export type PlacedSlots<TRow> = Readonly<
  Record<Slot, readonly FieldDef<TRow>[]>
>;

/** Where every field of a schema goes, for one view. */
export interface Placement<TRow> {
  /** Each slot's fields, in the order the view draws them: the user's
   *  Properties order when they set one, else the schema's. A slot the view
   *  does not draw is empty. */
  slots: PlacedSlots<TRow>;
  /** Each drawn field's importance — lower is more important; what gives way
   *  first when a view is narrow is the highest. Hidden fields have none. */
  priority: ReadonlyMap<string, number>;
  /** Each field's resolved kind (a view's default alignment reads it). */
  kinds: ReadonlyMap<string, FieldKind>;
  /** The form each slot's values take, from the view's declaration. */
  formOf: (slot: Slot) => SlotForm;
  /** What the engine decided that a surface author would want to know: a
   *  collision ("Created: edge taken → trail"), a promotion. */
  notes: readonly string[];
}

export interface PlacementInput<TRow> {
  /** The full schema. */
  fields: readonly FieldDef<TRow>[];
  /** Each field's kind (`usePlacement` resolves it from the type registry). */
  kindOf: (field: FieldDef<TRow>) => FieldKind;
  /** The slots this view draws — their capacities and forms. */
  viewSlots: ViewSlots;
  /** The surface's say: recipe, pins, emphasis. */
  spec: PlacementSpec;
  /** The view's Properties list (`ViewState.properties`). */
  properties: readonly PropertyEntry[] | null | undefined;
}

/** Kinds a title may be promoted from when the schema names no identity. */
const PROMOTABLE: ReadonlySet<FieldKind> = new Set([
  "prose",
  "label",
  "identifier",
]);

/** Where a title may be promoted from: the secondary slots, and `hidden` — a
 *  shown field the view had no room for (an icon grid draws neither line 2
 *  nor a trail, so its name would otherwise never be drawn). */
const PROMOTABLE_FROM: ReadonlySet<Slot> = new Set([
  "line2",
  "trail",
  "hidden",
]);

/**
 * THE placement engine: which slot each field is drawn in, and what gives way
 * first. Every view reads its answer; no view decides placement itself.
 *
 * 1. Hidden: `visible: false` (no Properties list), or not shown in the
 *    user's list.
 * 2. Pins, the most specific layer first: the user's (`PropertyEntry.slot`),
 *    then the surface's (`place`). A pin takes its slot if the view draws it
 *    and it has room; two surface pins on a one-field slot throw.
 * 3. The recipe walk: rule by rule, then field by field in declaration order,
 *    a field takes the first matching rule whose slot the view draws and has
 *    room. A field no rule places trails (or is hidden, in a view without a
 *    trail).
 * 4. With no title, the first shown label / prose / identifier field drawn on
 *    line 2, trailing, or left undrawn for want of room (a view without
 *    those slots — an icon grid) is promoted. A field the user hid stays
 *    hidden.
 * 5. Priority: `emphasis` first, then by slot rank (`SLOT_RANK`), then the
 *    drawing order within the slot.
 */
export function resolvePlacement<TRow>({
  fields,
  kindOf,
  viewSlots,
  spec,
  properties,
}: PlacementInput<TRow>): Placement<TRow> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [what, ids] of [
    ["place", Object.keys(spec.place ?? {})],
    ["emphasis", spec.emphasis ?? []],
  ] as const) {
    for (const id of ids) {
      if (!byId.has(id)) {
        throw new Error(
          `data-view placement: \`${what}\` names "${id}", which is no field of this list`,
        );
      }
    }
  }
  const kinds = new Map(fields.map((f) => [f.id, kindOf(f)]));
  const rules = RECIPES[spec.recipe ?? "record"];
  const capacity = (slot: Slot): number =>
    slot === "hidden"
      ? Infinity
      : viewSlots[slot] === undefined
        ? 0
        : (viewSlots[slot].capacity ?? Infinity);

  // The fields in body order, and which are shown.
  const shown: FieldDef<TRow>[] =
    properties == null
      ? fields.filter((f) => f.visible !== false)
      : orderFieldsBySection(
          properties
            .filter((p) => !p.hidden)
            .map((p) => byId.get(p.id))
            .filter((f): f is FieldDef<TRow> => f != null),
          [...fields],
        );
  const shownIds = new Set(shown.map((f) => f.id));
  const userSlot = new Map(
    (properties ?? []).flatMap((p) =>
      p.slot ? [[p.id, p.slot] as const] : [],
    ),
  );

  const slotOf = new Map<string, Slot>();
  const used = new Map<Slot, number>();
  const notes: string[] = [];
  const takes = (slot: Slot, f: FieldDef<TRow>) => {
    const only = slot === "hidden" ? undefined : viewSlots[slot]?.kinds;
    return only === undefined || only.includes(kinds.get(f.id)!);
  };
  const hasRoom = (slot: Slot, f: FieldDef<TRow>) =>
    (used.get(slot) ?? 0) < capacity(slot) && takes(slot, f);
  const put = (field: FieldDef<TRow>, slot: Slot) => {
    slotOf.set(field.id, slot);
    used.set(slot, (used.get(slot) ?? 0) + 1);
  };

  // 1. Hidden.
  for (const f of fields) if (!shownIds.has(f.id)) put(f, "hidden");

  // 2. Pins — the user's, then the surface's.
  for (const f of shown) {
    const slot = userSlot.get(f.id);
    if (slot !== undefined && hasRoom(slot, f)) put(f, slot);
  }
  for (const f of shown) {
    if (slotOf.has(f.id)) continue;
    const slot = spec.place?.[f.id];
    if (slot === undefined || capacity(slot) === 0 || !takes(slot, f)) continue;
    if (!hasRoom(slot, f)) {
      const holder = shown.find(
        (o) => slotOf.get(o.id) === slot && userSlot.get(o.id) !== slot,
      );
      if (holder) {
        throw new Error(
          `data-view placement: \`place\` pins both "${holder.id}" and "${f.id}" to "${slot}", which holds one field`,
        );
      }
      // The user moved another field there: theirs wins, and this one is
      // placed by the recipe.
      continue;
    }
    put(f, slot);
  }

  // 3. The recipe walk.
  const matches = (f: FieldDef<TRow>, match: string) =>
    match === "identity" ? f.primary === true : kinds.get(f.id) === match;
  for (const [match, slot] of rules) {
    for (const f of shown) {
      if (slotOf.has(f.id) || !matches(f, match) || !hasRoom(slot, f)) {
        continue;
      }
      put(f, slot);
    }
  }
  for (const f of shown) {
    if (!slotOf.has(f.id)) put(f, hasRoom("trail", f) ? "trail" : "hidden");
  }

  // Collisions, said out loud: a field whose first rule was a one-field slot
  // it did not get.
  for (const f of shown) {
    const wish = rules.find(([m]) => matches(f, m))?.[1];
    const got = slotOf.get(f.id);
    if (wish && got !== wish && capacity(wish) === 1) {
      notes.push(`${f.label}: ${wish} taken → ${got}`);
    }
  }

  // 4. Title promotion.
  if (!used.get("title") && capacity("title") > 0) {
    const candidate = shown.find(
      (f) =>
        PROMOTABLE_FROM.has(slotOf.get(f.id)!) &&
        userSlot.get(f.id) !== "hidden" &&
        PROMOTABLE.has(kinds.get(f.id)!) &&
        takes("title", f),
    );
    if (candidate) {
      slotOf.set(candidate.id, "title");
      used.set("title", 1);
      notes.push(`no title → ${candidate.label} promoted`);
    }
  }

  // Drawing order within a slot: the user's list when they set one (`shown`
  // is then in their order), else the schema's.
  const drawRank = new Map(shown.map((f, i) => [f.id, i]));
  const slots = Object.fromEntries(
    SLOTS.map((slot) => [
      slot,
      fields
        .filter((f) => slotOf.get(f.id) === slot)
        .sort(
          (a, b) =>
            (drawRank.get(a.id) ?? Infinity) - (drawRank.get(b.id) ?? Infinity),
        ),
    ]),
  ) as unknown as PlacedSlots<TRow>;

  // 5. Priority: emphasis, then slot rank, then drawing order.
  const emphasis = (spec.emphasis ?? []).filter(
    (id) => slotOf.get(id) !== "hidden",
  );
  const ranked = [
    ...emphasis,
    ...SLOT_RANK.flatMap((slot) =>
      slots[slot].map((f) => f.id).filter((id) => !emphasis.includes(id)),
    ),
  ];
  const priority = new Map(ranked.map((id, i) => [id, i]));
  const formOf = (slot: Slot): SlotForm =>
    slot === "hidden" ? "cell" : (viewSlots[slot]?.form ?? "cell");
  return { slots, priority, kinds, formOf, notes };
}

/** Kinds whose values read as numbers — a column of them aligns to the end. */
const END_ALIGNED: ReadonlySet<FieldKind> = new Set([
  "quantity",
  "duration",
  "ordinal",
  "instant",
]);

/** A field's text alignment: its own `align`, else its kind's default. */
export function fieldAlign<TRow>(
  field: FieldDef<TRow>,
  placement: Placement<TRow>,
): "start" | "end" | "center" {
  if (field.align) return field.align;
  return END_ALIGNED.has(placement.kinds.get(field.id) ?? "label")
    ? "end"
    : "start";
}

/**
 * Whether a drawn value wears the faint time ink (`listTimeInk`): the row's
 * `edge`, and every `instant` wherever it lands — so a row's times read alike
 * however many it has (a second instant falls to `trail`), in a list row and a
 * table column alike. The title is never faint.
 */
export function wearsTimeInk<TRow>(
  field: FieldDef<TRow>,
  slot: Slot,
  placement: Placement<TRow>,
): boolean {
  if (slot === "title") return false;
  return slot === "edge" || placement.kinds.get(field.id) === "instant";
}

/**
 * A field's drop order (lower drops first) — the reverse of its priority, for
 * the fields a view lets give way (`trail` and `edge`); `undefined` for the
 * rest (`lead`, `title` and the title cell's own lines never drop).
 */
export function dropOrderOf<TRow>(
  field: FieldDef<TRow>,
  slot: Slot,
  placement: Placement<TRow>,
): number | undefined {
  if (slot !== "trail" && slot !== "edge") return undefined;
  return -(placement.priority.get(field.id) ?? 0);
}

/**
 * The band each field is listed under in the Properties editor: a shown field's
 * slot, and for a field the user switched off, the slot it would take were it
 * shown again — so hiding a field toggles its state in place instead of moving
 * it to the Hidden band, and showing it puts it back where it was listed. Only
 * a field the view cannot draw even when shown (no room, no slot taking its
 * kind) is listed under Hidden.
 *
 * `placed` is the view's placement over `input.properties`; each hidden
 * field's home is a placement over the same list with just that field shown —
 * exactly what its eye would write.
 */
export function propertyBands<TRow>(
  input: PlacementInput<TRow>,
  placed: Placement<TRow>,
  items: readonly {
    field: FieldDef<TRow>;
    visible: boolean;
    slot?: Slot;
  }[],
): ReadonlyMap<string, Slot> {
  const bands = new Map<string, Slot>();
  for (const slot of SLOTS) {
    for (const f of placed.slots[slot]) bands.set(f.id, slot);
  }
  const entries = (shownId: string): PropertyEntry[] =>
    items.map((i) => ({
      id: i.field.id,
      ...(i.visible || i.field.id === shownId ? {} : { hidden: true as const }),
      ...(i.slot ? { slot: i.slot } : {}),
    }));
  for (const item of items) {
    if (item.visible) continue;
    const home = resolvePlacement({
      ...input,
      properties: entries(item.field.id),
    });
    const slot = SLOTS.find((s) =>
      home.slots[s].some((f) => f.id === item.field.id),
    );
    bands.set(item.field.id, slot ?? "hidden");
  }
  return bands;
}
