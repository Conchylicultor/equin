import { useState, type ComponentType, type ReactNode } from "react";
import {
  FilterValueInput,
  type FilterValueInputProps,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { NumberRange } from "../internal/number-lower";

/**
 * How a derived numeric type's operand is TYPED: a quantity in units
 * (`30s`, `1.5 GB`) that the operand input parses into the stored number —
 * the same number the type's values are, so number's lowering applies as is.
 */
export interface NumberOperandUnits {
  /** The typed text → the number it means, `null` when it means none. */
  readonly parse: (raw: string) => number | null;
  /** A stored operand → the text the input shows for it. */
  readonly format: (n: number) => string;
  /** The empty input's hint, naming the units it accepts (`e.g. 30s, 5m`). */
  readonly placeholder: string;
}

/** The two operand inputs an operator set renders: one value, and a range. */
export interface NumberOperandInputs {
  readonly ValueInput: ComponentType<FilterValueInputProps>;
  readonly RangeInput: ComponentType<FilterValueInputProps>;
}

function parsePlain(raw: string): number | undefined {
  if (raw === "") return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/** One plain numeric input. */
function PlainInput(props: {
  value: number | undefined;
  placeholder: string;
  onChange: (n: number | undefined) => void;
}): ReactNode {
  return (
    <FilterValueInput
      type="number"
      placeholder={props.placeholder}
      value={props.value ?? ""}
      onChange={(e) => props.onChange(parsePlain(e.target.value))}
    />
  );
}

/**
 * One unit-aware input: the user types `30s`, the operand is `30000`. The
 * typed text is kept locally (a half-typed `3` must not be rewritten to
 * `3ms`), and re-derived from the operand only when the operand changes from
 * outside (a reset, another rule's edit).
 */
function UnitInput(props: {
  value: number | undefined;
  placeholder: string;
  units: NumberOperandUnits;
  onChange: (n: number | undefined) => void;
}): ReactNode {
  const { value, units } = props;
  const shown = (n: number | undefined) =>
    n === undefined ? "" : units.format(n);
  const [text, setText] = useState(() => shown(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if (units.parse(text) !== (value ?? null)) setText(shown(value));
  }
  const invalid = text.trim() !== "" && units.parse(text) === null;
  return (
    <FilterValueInput
      type="text"
      inputMode="decimal"
      placeholder={props.placeholder}
      value={text}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const next = e.target.value;
        const n = next.trim() === "" ? null : units.parse(next);
        setText(next);
        setSynced(n ?? undefined);
        props.onChange(n ?? undefined);
      }}
    />
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * The operand inputs for a number operator set: plain numeric inputs, or —
 * handed a derived type's `units` — unit-aware text inputs over the same
 * stored number.
 */
export function numberOperandInputs(
  units?: NumberOperandUnits,
): NumberOperandInputs {
  function One(p: {
    value: number | undefined;
    placeholder: string;
    onChange: (n: number | undefined) => void;
  }): ReactNode {
    return units ? <UnitInput {...p} units={units} /> : <PlainInput {...p} />;
  }

  /** Single operand for the comparison operators (= ≠ > < ≥ ≤). */
  function ValueInput(props: FilterValueInputProps): ReactNode {
    return (
      <One
        value={asNumber(props.value)}
        placeholder={units?.placeholder ?? "Value"}
        onChange={(n) => props.onChange(n)}
      />
    );
  }

  /** Two operands forming an inclusive [min, max] range for `between`. */
  function RangeInput(props: FilterValueInputProps): ReactNode {
    const range = (props.value ?? {}) as NumberRange;
    function update(patch: Partial<NumberRange>) {
      props.onChange({ ...range, ...patch });
    }
    return (
      <Stack direction="row" gap="xs" align="center">
        <One
          value={range.min}
          placeholder="Min"
          onChange={(min) => update({ min })}
        />
        <Text as="span" variant="body" tone="muted">
          –
        </Text>
        <One
          value={range.max}
          placeholder="Max"
          onChange={(max) => update({ max })}
        />
      </Stack>
    );
  }

  return { ValueInput, RangeInput };
}
