import type { FieldDef } from "../../core";
import { pickCoverField } from "./cover";
import type { Placement } from "./placement";

/** A card's slots (gallery card, icons tile), each a field list in drawing order. */
export interface CardFields<TRow> {
  /** The row's lead: a visual is the card's picture when it has no cover;
   *  anything else is a glyph on the cover. */
  lead: FieldDef<TRow> | undefined;
  /** The title line's field. */
  title: FieldDef<TRow> | undefined;
  /** Marks drawn after the title. */
  afterTitle: FieldDef<TRow>[];
  /** The subtitle line, joined with "·". */
  line2: FieldDef<TRow>[];
  /** The token line: icon + value each. */
  trail: FieldDef<TRow>[];
  /** The token line's far end. */
  edge: FieldDef<TRow> | undefined;
}

/**
 * A card's text, read off the view's placement (`usePlacement`) — never a
 * partition of its own. The cover field (`FieldDef.cover`, else the first
 * `media` field) and every `media` field are the picture, so in no line.
 */
export function cardFieldsOf<TRow>(
  placement: Placement<TRow>,
): CardFields<TRow> {
  const { slots } = placement;
  const cover = pickCoverField(drawnFields(placement));
  const text = (list: readonly FieldDef<TRow>[]) =>
    list.filter((f) => f !== cover && f.type !== "media");
  return {
    lead: text(slots.lead)[0],
    title: text(slots.title)[0],
    afterTitle: text(slots.afterTitle),
    line2: text(slots.line2),
    trail: text(slots.trail),
    edge: text(slots.edge)[0],
  };
}

/** The fields a view's cover is read from: every field it draws. */
export function drawnFields<TRow>(
  placement: Placement<TRow>,
): FieldDef<TRow>[] {
  const { slots } = placement;
  return [
    ...slots.lead,
    ...slots.title,
    ...slots.afterTitle,
    ...slots.line2,
    ...slots.trail,
    ...slots.edge,
  ];
}
