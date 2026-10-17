import { useState, type ReactNode } from "react";
import type { FilterValueInputProps } from "@plugins/primitives/plugins/data-view/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  fromISODay,
  toISODay,
} from "@plugins/primitives/plugins/date-picker/core";
import { Calendar } from "@plugins/primitives/plugins/date-picker/web";
import {
  formatAnchor,
  type DateAnchor,
  type DateUnit,
  type DateRange,
  type RelativeRange,
} from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const calendarTodayIcon = symbol("calendar-today");

// Shared native-control chrome (matches the prior date-filter inputs and the
// Input primitive's border/bg/radius — native inputs are exempt from
// no-adhoc-control, which only fingerprints styled <button>/<a>).
const NATIVE_CONTROL =
  "rounded-md border border-input bg-background px-xs py-2xs text-body";

const UNIT_OPTIONS: { value: DateUnit; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

/** Normalize a stored operand into a `DateAnchor` (or undefined for none). */
function toAnchor(value: unknown): DateAnchor | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string") return { kind: "date", iso: value };
  return value as DateAnchor;
}

const PRESETS: { label: string; anchor: DateAnchor }[] = [
  { label: "Today", anchor: { kind: "relative", unit: "day", amount: 0 } },
  { label: "Yesterday", anchor: { kind: "relative", unit: "day", amount: -1 } },
  { label: "Tomorrow", anchor: { kind: "relative", unit: "day", amount: 1 } },
];

/**
 * The relative-magnitude + unit + direction builder, shared by the anchor
 * chooser's "custom relative" row. Emits a signed `{kind:"relative"}` anchor.
 */
function RelativeAnchorBuilder({
  anchor,
  onChange,
}: {
  anchor?: DateAnchor;
  onChange: (anchor: DateAnchor) => void;
}): ReactNode {
  const relative = anchor?.kind === "relative" ? anchor : undefined;
  const unit = relative?.unit ?? "day";
  const magnitude = relative ? Math.abs(relative.amount) : 1;
  const direction = relative && relative.amount < 0 ? "ago" : "from-now";

  function emit(next: {
    magnitude?: number;
    unit?: DateUnit;
    direction?: string;
  }) {
    const m = next.magnitude ?? magnitude;
    const u = next.unit ?? unit;
    const d = next.direction ?? direction;
    onChange({ kind: "relative", unit: u, amount: d === "ago" ? -m : m });
  }

  return (
    <Stack direction="row" gap="xs" align="center" wrap>
      <input
        type="number"
        min={1}
        className={`${NATIVE_CONTROL} w-16`}
        value={magnitude}
        onChange={(e) =>
          emit({ magnitude: Math.max(1, Number(e.target.value) || 1) })
        }
      />
      <select
        className={NATIVE_CONTROL}
        value={unit}
        onChange={(e) => emit({ unit: e.target.value as DateUnit })}
      >
        {UNIT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className={NATIVE_CONTROL}
        value={direction}
        onChange={(e) => emit({ direction: e.target.value })}
      >
        <option value="ago">ago</option>
        <option value="from-now">from now</option>
      </select>
    </Stack>
  );
}

/**
 * The popover-driven anchor chooser used by single and range date inputs.
 * Presets (Today/Yesterday/Tomorrow), a custom-relative builder, and an exact
 * date picker — each writes a `DateAnchor`.
 */
function AnchorChooser({
  anchor,
  onChange,
  placeholder = "Select date",
}: {
  anchor?: DateAnchor;
  onChange: (anchor: DateAnchor) => void;
  placeholder?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const label = formatAnchor(anchor);
  const exactIso = anchor?.kind === "date" ? anchor.iso : "";

  function pick(next: DateAnchor) {
    onChange(next);
    setOpen(false);
  }

  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      // No width: the month grid's section declares `picker` (a fixed 320px).
      // It used to be `fit`, which sized the panel to whichever operand row was
      // showing: the panel resized under the user as the operator changed,
      // which is exactly what a width ROLE exists to delete.
      label="Choose a date"
      // The rule row's one control shape: it fills its value cell and
      // truncates its label. A hand-built outline button here was rigid — wider
      // than the builder's value track, it reached into the next cell (and, in
      // a menu-wide panel, drew over the remove button).
      trigger={
        <ControlPanel.Field
          icon={<Icon icon={calendarTodayIcon} />}
          label={label || null}
          placeholder={placeholder}
        />
      }
    >
      <ControlPanel.Section label="Relative">
        {PRESETS.map((p) => (
          <ControlPanel.Row key={p.label} onSelect={() => pick(p.anchor)}>
            {p.label}
          </ControlPanel.Row>
        ))}
        {/* Vertical breathing room only — the inline inset is the panel's, and
            this control inherits it by doing nothing. */}
        <Inset y="2xs">
          <RelativeAnchorBuilder anchor={anchor} onChange={onChange} />
        </Inset>
      </ControlPanel.Section>
      <ControlPanel.Section needs="picker" label="Exact date">
        {/*
          `toISODay` is local-midnight, so the emitted operand stays the bare
          `yyyy-mm-dd` calendar day `resolveAnchorDay` (and its server
          filter-sql twin) already resolve — never a full ISO instant.
        */}
        <Calendar
          value={fromISODay(exactIso)}
          onSelect={(d) => pick({ kind: "date", iso: toISODay(d) })}
        />
      </ControlPanel.Section>
    </ControlPanelPopover>
  );
}

/** Single anchor chooser for the day-comparison operators (is / before / …). */
export function DateValueInput(props: FilterValueInputProps): ReactNode {
  const anchor = toAnchor(props.value);
  return (
    <AnchorChooser anchor={anchor} onChange={(next) => props.onChange(next)} />
  );
}

/** Two anchor choosers forming an inclusive [from, to] range for `is-between`. */
export function DateRangeInput(props: FilterValueInputProps): ReactNode {
  const range = (props.value ?? {}) as DateRange;

  function update(patch: Partial<DateRange>) {
    props.onChange({ ...range, ...patch });
  }

  return (
    <Stack direction="row" gap="xs" align="center">
      <AnchorChooser
        anchor={toAnchor(range.from)}
        onChange={(next) => update({ from: next })}
        placeholder="Start"
      />
      <Text variant="body" tone="muted">
        –
      </Text>
      <AnchorChooser
        anchor={toAnchor(range.to)}
        onChange={(next) => update({ to: next })}
        placeholder="End"
      />
    </Stack>
  );
}

/**
 * Relative magnitude + unit builder for the within operators (`is within the
 * past/next`). Emits `{unit, amount}` with a positive magnitude; direction is
 * implied by the operator. Defaults to `1 week`.
 */
export function RelativeRangeInput(props: FilterValueInputProps): ReactNode {
  const range = (props.value ?? {}) as Partial<RelativeRange>;
  const unit = range.unit ?? "week";
  const amount =
    typeof range.amount === "number" && range.amount > 0 ? range.amount : 1;

  function emit(next: { amount?: number; unit?: DateUnit }) {
    props.onChange({
      unit: next.unit ?? unit,
      amount: next.amount ?? amount,
    } satisfies RelativeRange);
  }

  return (
    <Stack direction="row" gap="xs" align="center">
      <input
        type="number"
        min={1}
        className={`${NATIVE_CONTROL} w-16`}
        value={amount}
        onChange={(e) =>
          emit({ amount: Math.max(1, Number(e.target.value) || 1) })
        }
      />
      <select
        className={NATIVE_CONTROL}
        value={unit}
        onChange={(e) => emit({ unit: e.target.value as DateUnit })}
      >
        {UNIT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Stack>
  );
}
