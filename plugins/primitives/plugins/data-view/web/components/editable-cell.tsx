import { useState, type MouseEvent, type ReactNode } from "react";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import type { FieldDef, FieldValue } from "../index";
import type { useResolveCellEditor } from "../index";
import { symbol } from "@plugins/ui/plugins/icons/core";

const editIcon = symbol("edit");

/**
 * A scalar FieldValue is "empty" when null/undefined or the empty string.
 * Numeric `0` and boolean `false` are real values, not empty.
 */
function isEmptyScalar(value: FieldValue): boolean {
  return value == null || value === "";
}

/** A multi-value field is empty when it holds no value. */
function isEmptyValues(values: readonly string[] | undefined): boolean {
  return !(values && values.length > 0);
}

/**
 * Whether `field` has nothing to show for `row` — THE empty test, shared by the
 * table's edit affordance (an empty editable cell offers its pencil over an
 * "Empty" placeholder) and the card / list meta (an empty field is simply
 * omitted, never drawn as "Empty").
 *
 * - multi-value (`values`) — no value;
 * - scalar (`value`) — null / undefined / `""` (`0` and `false` are values);
 * - display-only (`data`) — its projection is null / undefined;
 * - a field with none of them (a `cell`-only field) is never empty: only its
 *   cell knows what it draws.
 */
export function isFieldValueEmpty<TRow>(
  field: FieldDef<TRow>,
  row: TRow,
): boolean {
  if (field.values) return isEmptyValues(field.values(row));
  if (field.value) return isEmptyScalar(field.value(row));
  if (field.data) return field.data(row) == null;
  return false;
}

/**
 * Shared read affordance: the value, plus a hover-revealed pencil that is the
 * ONE way into edit mode.
 *
 * The value itself is deliberately **transparent to the click** — it neither
 * enters edit mode nor stops propagation, so a click anywhere on the row (the
 * text included) does the row's own thing: open the record. A cell that ate the
 * click made the row's primary action unreachable over most of its width, and
 * the user had to hunt for a gap between columns to open a record at all.
 *
 * Editing therefore needs a target of its own, and that target is the pencil:
 * one small button per editable field, revealed when the pointer is over that
 * field (or when it takes keyboard focus, which is also the only way a keyboard
 * user ever reached the editor). It is always mounted and only faded, so
 * revealing it never reflows the row — and `hoverRevealTarget` couples opacity
 * with pointer-events, so the hidden pencil is never an invisible click-target
 * sitting over the row.
 *
 * `display` picks the box: `"block"` is the row/table cell (a block-level flex
 * line, the value yielding so the pencil stays visible when the value is
 * longer than its track); `"inline"` flows inside a text run.
 */
function ReadAffordance(props: {
  empty: boolean;
  read: ReactNode;
  label: string;
  display: "block" | "inline";
  onEdit: (e: MouseEvent) => void;
}): ReactNode {
  const inline = props.display === "inline";
  const value = (
    <Text
      as={inline ? "span" : "div"}
      // The value yields (falls below its own content width) but never grows:
      // it truncates rather than pushing the pencil out of the cell, and a
      // short value keeps the pencil right next to it instead of parking it at
      // the far edge of the column.
      className={yieldClass("x")}
    >
      {props.empty ? (
        <span className="italic text-muted-foreground/50">Empty</span>
      ) : (
        props.read
      )}
    </Text>
  );
  const pencil = (
    // `xs` is the row-affordance density (the same one `RowActions` applies):
    // this is chrome sitting inside a line of data, not a control of its own.
    <ControlSizeProvider size="xs">
      <IconButton
        icon={editIcon}
        label={`Edit ${props.label}`}
        className={cn(hoverRevealTarget, rigidClass())}
        // Both halves are load-bearing: the click must not reach the row (it
        // would activate the row we are editing IN), and the pointerdown must
        // not reach it either (a table/list row is its own drag source, so the
        // press would arm a reorder drag from the pencil).
        onClick={props.onEdit}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </ControlSizeProvider>
  );
  return inline ? (
    <Inline gap="2xs" className={hoverRevealGroup}>
      {value}
      {pencil}
    </Inline>
  ) : (
    <Stack
      direction="row"
      gap="2xs"
      align="center"
      className={hoverRevealGroup}
    >
      {value}
      {pencil}
    </Stack>
  );
}

/**
 * Presentational edit wrapper for one field cell. Holds ONLY an `editing`
 * boolean — the parent owns `resolveEditor` (hooks must run unconditionally at
 * the view top level) and the write-back. A field is scalar (`value` +
 * `onEdit`) or multi-value (`values` + `onEditValues`); the empty-check and the
 * commit channel follow whichever the field declares.
 *
 * Edit mode is entered from the read affordance's pencil, never from the value:
 * the row owns clicks on its own content. Once open, the editor `stopPropagation`s
 * so typing/clicking inside it never activates the row underneath.
 *
 * `autoEdit` starts the cell in edit mode on mount (the contributed slot editors
 * `autoFocus`, so mounting the editor focuses it) — used by the tree's
 * auto-focus-on-create. `display` controls layout of both the read affordance
 * and the editor wrapper: `"block"` (default) fills the cell; `"inline"` flows
 * inline inside text.
 */
export function EditableCell(props: {
  field: FieldDef<unknown>;
  row: unknown;
  value: FieldValue;
  values?: readonly string[];
  read: ReactNode;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
  autoEdit?: boolean;
  display?: "block" | "inline";
  onEdit?: (row: unknown, next: FieldValue) => void | Promise<void>;
  onEditValues?: (row: unknown, next: string[]) => void | Promise<void>;
}): ReactNode {
  const [editing, setEditing] = useState(props.autoEdit ?? false);
  const display = props.display ?? "block";
  const isMulti = props.field.values != null;
  const empty = isMulti
    ? isEmptyValues(props.values)
    : isEmptyScalar(props.value);
  const read = (
    <ReadAffordance
      empty={empty}
      read={props.read}
      label={props.field.label}
      display={display}
      onEdit={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    />
  );

  if (editing) {
    const editor = props.resolveEditor({
      field: props.field,
      value: props.value,
      values: props.values,
      raw: props.row,
      onCommit: (next) => {
        setEditing(false);
        void props.onEdit?.(props.row, next);
      },
      onCommitValues: (next) => {
        setEditing(false);
        void props.onEditValues?.(props.row, next);
      },
      onCancel: () => setEditing(false),
    });
    if (editor) {
      // `min-w-0` is dropped: a block wrapper's min-width is already 0, and the
      // inline `<Inline>` constrains itself — the cell track (min-w-0) is what
      // lets the editor shrink.
      return display === "inline" ? (
        <Inline gap="none" as="span" onClick={(e) => e.stopPropagation()}>
          {editor}
        </Inline>
      ) : (
        <div className="w-full" onClick={(e) => e.stopPropagation()}>
          {editor}
        </div>
      );
    }
    // No contributed editor for this type → never trap the user.
    return read;
  }
  return read;
}
