import type { FieldDef } from "../../core";
import { pickCoverField } from "./cover";
import { pickLeadingField } from "./pick-leading-field";
import { pickPrimaryField } from "./pick-primary-field";

/** The text lines of a card (gallery card, list row meta), each a field list. */
export interface CardFields<TRow> {
  /** The title line's field (`pickPrimaryField`). */
  title: FieldDef<TRow> | undefined;
  /** The row's leading visual (`FieldDef.leading`) — drawn in the leading
   *  slot, never as text. */
  leading: FieldDef<TRow> | undefined;
  /** Row-state marks (`FieldDef.indicator`), drawn after the title. */
  indicators: FieldDef<TRow>[];
  /** Text fields, joined with "·" on the subtitle line. */
  subtitle: FieldDef<TRow>[];
  /** Every other field, as icon + value tokens on one line. */
  tokens: FieldDef<TRow>[];
}

/**
 * THE card text partition, in body order. Takes the view's VISIBLE fields
 * (`resolveBodyFields`), so a card follows the view's Properties like every
 * other body.
 *
 * - `leading` — the `leading: true` field (at most one; throws otherwise).
 * - The cover field (`FieldDef.cover`, else the first `media` field) and any
 *   `media` field are the picture, never text: in no line.
 * - `title` — `pickPrimaryField` over the rest, indicators aside.
 * - `indicators` — `indicator: true` fields.
 * - `subtitle` — fields of type `text` (the default type).
 * - `tokens` — everything else.
 */
export function partitionCardFields<TRow>(
  fields: readonly FieldDef<TRow>[],
): CardFields<TRow> {
  const leading = pickLeadingField([...fields]);
  const cover = pickCoverField(fields);
  const rest = fields.filter(
    (f) => f !== leading && f !== cover && f.type !== "media",
  );
  const title = pickPrimaryField(rest.filter((f) => f.indicator !== true));
  const out: CardFields<TRow> = {
    title,
    leading,
    indicators: [],
    subtitle: [],
    tokens: [],
  };
  for (const f of rest) {
    if (f === title) continue;
    if (f.indicator === true) out.indicators.push(f);
    else if ((f.type ?? "text") === "text") out.subtitle.push(f);
    else out.tokens.push(f);
  }
  return out;
}
