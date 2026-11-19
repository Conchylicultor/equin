import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { useState, type ReactNode } from "react";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { and, clause } from "@plugins/network/plugins/live/plugins/filter/core";
import type {
  FieldOption,
  FieldOptionsResult,
  FieldOptionsWindow,
  FilterValueInputProps,
} from "../../../core";
import {
  selectChoices,
  type SelectChoice,
} from "../../internal/select-choices";
import { SEARCH_DEBOUNCE_MS, useDebounced } from "../../internal/live-source";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

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
 *
 * A field whose values are an OPEN set (`optionsWindow` — a site's visited
 * pages) is read one window at a time while the popover is open: the top of
 * the set, or — as the user types — the rows whose search column contains
 * it, run by the server, never filtered from a partial list here. A
 * window with more past it says so; a selected value outside the window
 * still gets its chip first (to be clicked off), never marked "not listed".
 */
export function ChipSelectFilterInput(
  props: FilterValueInputProps & { multiple: boolean },
): ReactNode {
  const { multiple } = props;
  const state: FieldOptionsResult = props.field.optionsResult ?? {
    status: "ready",
    options: props.field.options ?? NO_OPTIONS,
  };
  const window = props.field.optionsWindow;
  const options = state.status === "ready" ? state.options : NO_OPTIONS;
  const [open, setOpen] = useState(false);

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

  return (
    <InlinePopover
      resetOnClose
      open={open}
      onOpenChange={setOpen}
      width="md"
      trigger={
        // The rule row's control shape: it fills its cell and truncates, so a
        // long pick (a page path) shortens in place instead of widening the row.
        <ControlPanel.Field
          aria-label="Select filter values"
          label={summary}
          {...(props.placeholder === undefined
            ? {}
            : { placeholder: props.placeholder })}
        />
      }
    >
      {window !== undefined ? (
        // Read only while open: a closed picker holds no window.
        open && (
          <WindowedChoices window={window} selected={selected} onPick={pick} />
        )
      ) : (
        <ClosedChoices state={state} selected={selected} onPick={pick} />
      )}
    </InlinePopover>
  );
}

/** The picker over a closed option set: every option, searched in memory. */
function ClosedChoices({
  state,
  selected,
  onPick,
}: {
  state: FieldOptionsResult;
  selected: readonly string[];
  onPick: (value: string) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  if (state.status === "loading") return <Loading label="Loading options…" />;
  if (state.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        error={state.error}
        refetch={state.refetch}
        subject="this field's values"
      />
    );
  const choices = selectChoices(state.options, selected);
  const q = query.trim().toLowerCase();
  const visible = q
    ? choices.filter(
        ({ option }) =>
          option.label.toLowerCase().includes(q) ||
          option.value.toLowerCase().includes(q),
      )
    : choices;
  return (
    <Stack gap="sm">
      {choices.length > 6 && (
        <ChoicesSearch value={query} onChange={setQuery} />
      )}
      <ChoiceGrid choices={visible} selected={selected} onPick={onPick} />
    </Stack>
  );
}

/**
 * The picker over an open option set: one window of its collection — the top
 * in the collection's default order, or the rows whose search column contains
 * the typed text — the selected values first (outside the window too, so
 * each can be clicked off), then the window.
 */
function WindowedChoices({
  window,
  selected,
  onPick,
}: {
  window: FieldOptionsWindow;
  selected: readonly string[];
  onPick: (value: string) => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const state = useLive(
    window.collection,
    {
      where:
        search === ""
          ? window.where
          : and(window.where, clause(window.search, "contains", search)),
    },
    // A new search keeps the previous window on screen until it answers.
    { resetKey: window.collection.key },
  );
  return (
    <Stack gap="sm">
      <ChoicesSearch value={query} onChange={setQuery} />
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
        <>
          <ChoiceGrid
            // A selected value outside the window is not "unlisted": the
            // window shows only part of the set.
            choices={selectChoices(state.data.map(window.option), selected).map(
              (c) => ({
                ...c,
                listed: true,
              }),
            )}
            selected={selected}
            onPick={onPick}
          />
          {state.canGrow && (
            <Placeholder tone="muted">
              More values than shown — search to find others.
            </Placeholder>
          )}
        </>
      )}
    </Stack>
  );
}

function ChoicesSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <SearchInput
      appearance="menu"
      autoFocus
      placeholder="Search…"
      keep={transient(
        "picker query in a popover that closes on remount; several filter rules share one pane",
      )}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ChoiceGrid({
  choices,
  selected,
  onPick,
}: {
  choices: readonly SelectChoice[];
  selected: readonly string[];
  onPick: (value: string) => void;
}): ReactNode {
  if (choices.length === 0)
    return <Placeholder tone="muted">No matches</Placeholder>;
  return (
    <Stack direction="row" gap="xs" wrap>
      {choices.map(({ option, listed }) => (
        <ToggleChip
          key={option.value}
          active={selected.includes(option.value)}
          variant="ghost"
          icon={listed ? undefined : <Icon icon={helpIcon} />}
          tooltip={
            listed
              ? undefined
              : `${option.value} — not one of this field's listed options`
          }
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </ToggleChip>
      ))}
    </Stack>
  );
}

const NO_OPTIONS: readonly FieldOption[] = [];
