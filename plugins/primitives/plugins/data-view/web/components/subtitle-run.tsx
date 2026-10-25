import type { ReactNode } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import type { FieldDef } from "../../core";
import type { useResolveCell } from "../cell-slot";
import type { useResolveCellEditor } from "../cell-editor-slot";
import { FieldCell } from "./field-cell";
import { isFieldValueEmpty } from "./editable-cell";

/**
 * What sits right before the run on its line: the title (a chip or text — on
 * one line the title is simply the run's first term), or nothing (the run
 * starts its line: a stacked subtitle, a title cell's second line).
 */
export type SubtitleSeam = "chip" | "text" | null;

/**
 * The subtitle terms a row draws, as indices into `fields`: every field whose
 * value is not empty. An empty value is left out of the run — never drawn as
 * the italic "Empty" (that placeholder is for a cell standing on its own, not
 * a term in a sentence) — and takes its separator with it.
 */
export function drawnSubtitleTerms(
  fields: readonly FieldDef<unknown>[],
  row: unknown,
): number[] {
  const terms: number[] = [];
  fields.forEach((field, fi) => {
    if (!isFieldValueEmpty(field, row)) terms.push(fi);
  });
  return terms;
}

export interface SubtitleRunProps {
  /** The run's fields, in order (a view's type-erased schema). */
  fields: readonly FieldDef<unknown>[];
  /** Which of `fields` render as a chip (`useIsChipField`, per schema). */
  isChip: readonly boolean[];
  /** The terms this row draws (`drawnSubtitleTerms`). */
  terms: readonly number[];
  /** What precedes the run on its line — see {@link SubtitleSeam}. */
  seam: SubtitleSeam;
  row: unknown;
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
}

/**
 * A row's subtitle run — the list row's subtitle, a soft table's title-cell
 * second line: each drawn term with its separator, as inline content for ONE
 * truncating `<Text>` leaf the caller draws around it (so the whole run
 * ellipsizes as a single leaf of its line).
 *
 * ` · ` is a punctuation mark between two pieces of text; it is not what
 * separates two chips, which already carry their own boundary. So the middot
 * is drawn only between two adjacent NON-chip terms, and a chip is separated
 * by spacing alone — otherwise a row of three enum fields renders
 * `name · [Web page] · [Daily] · [Failed]`, middots glued to pills. The
 * spacing is a literal space in the flow, not a flex `gap` — a flex container
 * here would make each chip its own leaf and take the truncation with it.
 */
export function SubtitleRun({
  fields,
  isChip,
  terms,
  seam,
  row,
  resolveCell,
  resolveEditor,
}: SubtitleRunProps): ReactNode {
  return terms.map((fi, i) => {
    // The term DRAWN before this one — an empty value is skipped, so its
    // neighbour is the previous non-empty term; the first term's is the seam.
    const prevIsChip =
      i > 0 ? isChip[terms[i - 1]!]! : seam === null ? null : seam === "chip";
    const separator =
      prevIsChip === null ? null : prevIsChip || isChip[fi] ? " " : " · ";
    const field = fields[fi]!;
    const cell = (
      <FieldCell
        field={field}
        row={row}
        resolveCell={resolveCell}
        resolveEditor={resolveEditor}
        display="inline"
      />
    );
    // The run is inline flow, but a cell is free to lay itself out as a block
    // — a chip group is typically a wrapping flex row — and a block inside
    // the run breaks the line. A chip term is therefore drawn in an
    // inline-flex box (`Inline`), where whatever box the cell draws is a flex
    // item on the run's line. A text term stays bare inline content, so it
    // still ellipsizes with the run.
    return (
      <span key={field.id}>
        {separator}
        {isChip[fi] ? (
          <Inline gap="none" className="max-w-full">
            {cell}
          </Inline>
        ) : (
          cell
        )}
      </span>
    );
  });
}
