import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { useState, type ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type {
  FieldOption,
  FieldOptionsResult,
  FilterValueInputProps,
} from "../../../core";
import { selectChoices } from "../../internal/select-choices";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const keyboardArrowDownIcon = symbol("keyboard-arrow-down");
const helpIcon = symbol("help");

/**
 * The shared option-select operand editor for enum/tags-style filters. Instead of
 * spilling every `field.options` chip inline into the rule row's narrow `flex-1`
 * value cell (where dozens of options collapse into a truncated one-per-line
 * column — unreadable), it renders a compact picker-style trigger summarizing the
 * selection (mirroring the sibling field/operator pickers) and opens a roomy
 * popover with a search box + a wrapping, never-truncated chip grid. This is the
 * filter-side twin of the inline tags cell editor, so picking options feels
 * identical wherever a tag/enum field appears.
 *
 * `multiple` switches the operand shape: a `string[]` of toggled values
 * (contains-any/all, is-any-of/none-of) vs. a single `string` (contains /
 * is / is-not). Single-select closes the popover on pick; multi stays open so
 * several can be toggled in one pass.
 *
 * A selected value the field does not list gets a chip too. A saved view
 * outlives the option set that produced it, and some field types deliberately
 * keep a persisted value out of the picker (`model` hides the print-only
 * models) — so an operand missing from `options` is not necessarily wrong, it is
 * merely unlisted, and the chip says exactly that rather than calling it
 * invalid. Without one it is unreachable: the trigger counts it in "2 selected"
 * while the grid shows nothing to click off.
 *
 * A field whose options are READ (`optionsResult` — a live source's facet)
 * shows the read's state in the popover while it is not ready: loading, or the
 * failure with its Retry. Never an empty grid, which would claim the column
 * has no values (and mark every selected value "not listed").
 */
export function ChipSelectFilterInput(
  props: FilterValueInputProps & { multiple: boolean },
): ReactNode {
  const { multiple } = props;
  const state: FieldOptionsResult = props.field.optionsResult ?? {
    status: "ready",
    options: props.field.options ?? NO_OPTIONS,
  };
  const options = state.status === "ready" ? state.options : NO_OPTIONS;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = multiple
    ? Array.isArray(props.value)
      ? (props.value as string[])
      : []
    : typeof props.value === "string" && props.value
      ? [props.value]
      : [];

  const labelFor = (v: string) =>
    options.find((o) => o.value === v)?.label ?? v;

  function pick(v: string) {
    if (multiple) {
      const next = selected.includes(v)
        ? selected.filter((x) => x !== v)
        : [...selected, v];
      props.onChange(next.length > 0 ? next : undefined);
    } else {
      props.onChange(selected[0] === v ? undefined : v);
      setOpen(false);
    }
  }

  const first = selected[0];
  const summary =
    first === undefined
      ? null
      : selected.length === 1
        ? labelFor(first)
        : `${selected.length} selected`;

  const choices = selectChoices(options, selected);

  const q = query.trim().toLowerCase();
  const visible = q
    ? choices.filter(
        ({ option }) =>
          option.label.toLowerCase().includes(q) ||
          option.value.toLowerCase().includes(q),
      )
    : choices;

  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      width="md"
      trigger={
        <Button variant="outline" aria-label="Select filter values">
          {summary === null ? (
            <span className="text-muted-foreground">Select…</span>
          ) : (
            <span className="truncate">{summary}</span>
          )}
          <Icon icon={keyboardArrowDownIcon} />
        </Button>
      }
    >
      {state.status === "loading" ? (
        <Loading label="Loading options…" />
      ) : state.status === "error" ? (
        <ResourceErrorInline
          variant="inline"
          error={state.error}
          refetch={state.refetch}
          subject="this field's values"
        />
      ) : (
        <Stack gap="sm">
          {choices.length > 6 && (
            <SearchInput
              appearance="menu"
              autoFocus
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {visible.length > 0 ? (
            <Stack direction="row" gap="xs" wrap>
              {visible.map(({ option, listed }) => (
                <ToggleChip
                  key={option.value}
                  active={selected.includes(option.value)}
                  variant="ghost"
                  icon={listed ? undefined : <Icon icon={helpIcon} />}
                  title={
                    listed
                      ? undefined
                      : `${option.value} — not one of this field's listed options`
                  }
                  onClick={() => pick(option.value)}
                >
                  {option.label}
                </ToggleChip>
              ))}
            </Stack>
          ) : (
            <Placeholder tone="muted">No matches</Placeholder>
          )}
        </Stack>
      )}
    </InlinePopover>
  );
}

const NO_OPTIONS: readonly FieldOption[] = [];
