import type React from "react";

import type { ControlPanelHandleProps } from "./handle";
import {
  SettingNote,
  SettingRow,
  type ControlPanelFit,
  type ControlPanelMark,
} from "./setting-row";

export interface ControlPanelSettingProps {
  /** The setting's name — the label cell, on the one text rail. REQUIRED. */
  label: React.ReactNode;
  /**
   * Explanatory prose as a TOOLTIP, wired by `aria-describedby` — never a second
   * line. See `HintedLabelCell`.
   */
  hint?: string;
  /**
   * THE CONTROL. Interactive by contract: this row's box is a plain `<div>`, so
   * nesting is legal here and only here. There is NO `onSelect` and NO `href` on
   * this type, so the row can never become a click target — the
   * nested-interactive shape is unspellable rather than discouraged.
   */
  control: React.ReactNode;
  /**
   * `"field"`  — takes the panel's field width, so every dropdown and input in
   *              the panel comes out the same size and starts at one x.
   * `"inline"` — sizes to its own content (a swatch, an avatar, a stepper).
   *
   * REQUIRED, so the answer is declared rather than defaulted. The value TRACK
   * itself is derived per panel from `data-cp-value`, exactly as `data-cp-icon`
   * and `data-cp-handle` already work.
   */
  fit: ControlPanelFit;
  /** Presentational, in flow, before the actions — a tier chip, a unit, a count. */
  status?: React.ReactNode;
  /** Hover-revealed cluster, through `RowActions pin={null}`. */
  actions?: React.ReactNode;
  /** Chrome-gutter stripe. Costs no track. */
  mark?: ControlPanelMark;
  /** A line under the row, on the rail — a conflict line, a validation message. */
  note?: React.ReactNode;
  /**
   * Shows the drag handle in the gutter (revealed on row hover/focus) — a
   * member of a reorderable list. Like `Row`'s, it opens the panel's gutter
   * track, so every label in the panel moves with it (invariant #1).
   */
  handle?: boolean;
  /** dnd-kit listeners/attributes (and an activator `ref`) for that handle. */
  handleProps?: ControlPanelHandleProps;
  disabled?: boolean;
  className?: string;
}

/**
 * THE VALUE ROW — "Label ………… [ control ]", the shape the vocabulary had no way
 * to say, and the shape config is full of.
 *
 * It is a new member, not a fourth `select` arm and not a promoted `Field`:
 *
 *  - Not a `select` arm. `select` is the SELECTION-LANGUAGE axis and invariant
 *    #3 says there are three of those. A dropdown is not a fourth way to say
 *    "on", it is a control inside a cell — and `Row`'s host is inferred from
 *    `onSelect`/`href`, so a `Row` holding a dropdown would be a `<button>`
 *    inside a `<button>`. A `select="value"` arm would type that as correct.
 *  - Not a promoted `Field`. `ControlPanel.Field` is THE BOX A VALUE IS PICKED
 *    FROM — an outline `Button`, `w-full justify-between`, truncating. It is
 *    correct as a cell-level control and the filter builder needs it to stay
 *    one.
 *
 * There is deliberately NO `icon`. The leading-track `:has()` scan is per PANEL,
 * so one field carrying a type icon would indent EVERY label in that panel by an
 * icon column — and a config field is contributed into panels its host does not
 * own, so the trigger for that would live in another plugin's descriptor. It is
 * the quick-theme footer-glyph failure with a longer fuse, and it is excluded at
 * the type level exactly as `icon` is already excluded from the check/radio arm.
 */
export function ControlPanelSetting({
  label,
  hint,
  control,
  fit,
  status,
  actions,
  mark,
  note,
  handle,
  handleProps,
  disabled,
  className,
}: ControlPanelSettingProps) {
  return (
    <>
      <SettingRow
        label={label}
        hint={hint}
        control={control}
        fit={fit}
        status={status}
        actions={actions}
        mark={mark}
        handle={handle}
        handleProps={handleProps}
        disabled={disabled}
        className={className}
      />
      {note != null ? <SettingNote>{note}</SettingNote> : null}
    </>
  );
}
