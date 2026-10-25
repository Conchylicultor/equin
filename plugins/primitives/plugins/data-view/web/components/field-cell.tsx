import type { ReactNode } from "react";
import type {
  FieldDef,
  FieldValue,
  useResolveCell,
  useResolveCellEditor,
} from "../index";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { EditableCell } from "./editable-cell";
import { useFieldCellContext } from "../internal/field-extents";
import {
  isElidedRead,
  useFieldPresentation,
  visibleValues,
} from "../internal/field-presentation";

/**
 * Thrown by `FieldCell` when a field declares `data` but neither a `cell`
 * override nor a contributed type cell can draw it — a crash the enclosing
 * view's error boundary surfaces, instead of a silently blank cell.
 */
export class MissingDataCellError extends Error {
  constructor(field: FieldDef<unknown>) {
    super(
      `data-view: field "${field.id}" declares \`data\` but no cell is registered for its type "${field.type ?? "text"}" — nothing can draw it`,
    );
    this.name = "MissingDataCellError";
  }
}

/**
 * The single "render a field's value, editable when it declares `onEdit`"
 * component, used by every view. Read precedence is uniform: consumer
 * `field.cell` override → contributed `data-view.cell` slot (`resolveCell`) →
 * `String(value)`. In the `token` context (a card's token line) the field's
 * own `token` renderer comes first: `field.token` → `field.cell` → the type's
 * cell. Either renderer is handed the field's `extent` when it declares
 * `extent: true` (`FieldExtentsContext`, provided by the body). Inside a row
 * view's `FieldPresentationProvider` the type's cell is handed
 * `presentation: "quiet"`, and the value most of the view's rows share is left
 * out — a scalar draws nothing, a multi-value field draws the rest. When the
 * field declares a write-back (`onEdit`/`onEditValues`) the read is wrapped
 * in `EditableCell` for click-to-edit; otherwise the read is rendered bare.
 */
export interface FieldCellProps {
  field: FieldDef<unknown>;
  row: unknown;
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
  display?: "block" | "inline";
  /**
   * Where the value is drawn: `"cell"` (default — a table cell, a list term)
   * or `"token"` (a card's token line, a compact meta run), where the field's
   * short form (`FieldDef.token`) wins over its cell.
   */
  context?: "cell" | "token";
}

export function FieldCell({
  field,
  row,
  resolveCell,
  resolveEditor,
  display,
  context = "cell",
}: FieldCellProps): ReactNode {
  // A field declaring `extent: true` is handed its extent over the view's rows.
  const cellContext = useFieldCellContext(field);
  // The enclosing view's presentation: quiet + elision in a row view, the
  // chip default elsewhere (a table, a lone cell).
  const presentation = useFieldPresentation();
  // A field whose values failed to load has no value to draw — say so, per
  // cell, rather than draw the decode of `undefined` (an unset-looking cell).
  if (field.readError) {
    return (
      <ResourceErrorInline
        variant="icon"
        error={field.readError.error}
        refetch={field.readError.refetch}
        subject={field.label}
      />
    );
  }
  // Not known yet: the loading block, never the value a pending field
  // stands in with (which would read as unset).
  if (field.pending === true) {
    return <Loading variant="block" className="h-4 w-12" />;
  }
  // A value most of the view's rows share says nothing: the cell draws none
  // (its slot keeps its width — the list's slots are sized by the view).
  if (isElidedRead(presentation, field, row)) return null;
  const value = field.value?.(row);
  const values = visibleValues(presentation, field, field.values?.(row));
  const own = context === "token" ? (field.token ?? field.cell) : field.cell;
  const read = own
    ? own(row, cellContext)
    : (resolveCell(
        field,
        value,
        row,
        values,
        presentation.presentation === "quiet" ? "quiet" : undefined,
      ) ?? readFallback(field, value));
  if (field.onEdit != null || field.onEditValues != null) {
    return (
      <EditableCell
        field={field}
        row={row}
        value={value}
        values={values}
        read={read}
        resolveEditor={resolveEditor}
        display={display}
        onEdit={
          field.onEdit as
            | ((row: unknown, next: FieldValue) => void | Promise<void>)
            | undefined
        }
        onEditValues={
          field.onEditValues as
            ((row: unknown, next: string[]) => void | Promise<void>) | undefined
        }
      />
    );
  }
  return <>{read}</>;
}

/** The `String(value)` fallback — refused for a `data` field, whose projection
 *  only a type cell can draw: an empty string there would hide the missing cell
 *  (e.g. the type's cell plugin is absent from the composition). Exported for
 *  the one read path that does not go through `FieldCell` (the tree's primary
 *  label), so both reads refuse the same way. */
export function readFallback(
  field: FieldDef<unknown>,
  value: FieldValue,
): string {
  if (field.data != null) throw new MissingDataCellError(field);
  return String(value ?? "");
}
