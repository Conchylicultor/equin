import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  addMonths,
  buildMonthGrid,
  dayLabel,
  isDayInBounds,
  isSameDay,
  isSameMonth,
  monthTitle,
  pickFocusDay,
  resolveDayNavigation,
  startOfDay,
  startOfMonth,
  toISODay,
  weekdayLabels,
} from "../../core";
import { announce } from "@plugins/primitives/plugins/announce/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

const chevronLeftIcon = symbol("chevron-left");
const chevronRightIcon = symbol("chevron-right");

export interface CalendarProps {
  /**
   * The selected day. Compared by LOCAL calendar day, so any time-of-day works
   * — the panel's time field owns the clock part.
   */
  value?: Date | null;
  /** Fired with LOCAL midnight of the clicked day. */
  onSelect?: (day: Date) => void;
  /**
   * The displayed month (any day within it). Pass with `onMonthChange` for a
   * controlled pager; omit both and the calendar keeps its own month, seeded
   * from `value` (or today).
   */
  month?: Date;
  onMonthChange?: (month: Date) => void;
  /** First grid column's weekday, 0 = Sunday (the default). */
  weekStartsOn?: number;
  /** Inclusive selectable bounds, day-granular. Days outside are disabled. */
  min?: Date;
  max?: Date;
  /** BCP-47 locale for the month title + weekday row. Defaults to the runtime's. */
  locale?: string;
  className?: string;
}

/**
 * The bare month grid: a prev/next header plus 6×7 day cells.
 *
 * Exported separately from `DatePickerPanel` because two of the three consumers
 * want ONLY this — the date-filter's "Exact date" section has its own relative
 * presets above it (which a calendar cannot express) and no time concept, so it
 * seeds from a `yyyy-mm-dd` string and takes the picked day, nothing more.
 *
 * Hand-rolled on the layout primitives rather than vendoring a `Calendar`: the
 * month is seven `Grid cols={7}` rows, and `Button` + `ControlSizeProvider` give
 * day cells that follow the active theme's radius/density tokens for free.
 */
export function Calendar({
  value,
  onSelect,
  month,
  onMonthChange,
  weekStartsOn = 0,
  min,
  max,
  locale,
  className,
}: CalendarProps) {
  const today = startOfDay(new Date());
  const [ownMonth, setOwnMonth] = useState(() =>
    startOfMonth(value ?? new Date()),
  );
  // The day the keyboard last moved to. Only a HINT — the rendered roving target
  // is derived below, so this can never strand `tabIndex=0` on a day that is not
  // on screen.
  const [focusedDay, setFocusedDay] = useState<Date | null>(null);

  const titleId = useId();
  const gridRef = useRef<HTMLElement>(null);
  // The ISO day the next commit should put DOM focus on, written by the key
  // handler and consumed by the layout effect below. A ref rather than state:
  // it is a one-shot instruction, not something the render reads.
  const pendingFocus = useRef<string | null>(null);

  // Controlled iff `month` is supplied; the internal state is then inert rather
  // than a second source of truth that can drift from the prop.
  const isControlled = month !== undefined;
  const viewMonth = month ?? ownMonth;

  function goToMonth(next: Date) {
    const target = startOfMonth(next);
    if (!isControlled) setOwnMonth(target);
    onMonthChange?.(target);
    // The visible month is the one thing paging changes that has no native
    // carrier: the chevrons keep their own labels ("Next month"), and a
    // PageDown moves nothing that is focused. Announced here — the calendar's
    // one paging path — so both routes report it exactly once. A month change
    // driven from OUTSIDE (a `DatePickerPanel` preset) is not announced, since
    // that press has its own button label.
    announce(monthTitle(target, locale));
  }

  function pick(day: Date) {
    // Clicking a leading/trailing cell pages to that day's month, so the
    // selection is never left off-screen.
    if (!isSameMonth(day, viewMonth)) goToMonth(day);
    // The click is also a focus move: the browser has focused this button, so
    // the roving target must follow it, or the next arrow key would walk from
    // wherever the tab stop happened to be instead of from the day under the
    // user's cursor.
    setFocusedDay(day);
    onSelect?.(day);
  }

  const weeks = buildMonthGrid(viewMonth, weekStartsOn);
  const headings = weekdayLabels(weekStartsOn, locale);

  // The roving tab stop is DERIVED, never stored: a `focusedDay` left over from
  // a month the user has since paged away from is ignored outright, so the
  // `tabIndex=0` is always on a button that is actually rendered. Keyboard
  // navigation sets the focused day and the view month together, so this needs
  // no synchronising effect.
  const activeDay =
    focusedDay !== null && isSameMonth(focusedDay, viewMonth)
      ? focusedDay
      : pickFocusDay({ weeks, viewMonth, value, today, min, max });

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    const next = resolveDayNavigation(
      { key: event.key, shiftKey: event.shiftKey },
      activeDay,
      weekStartsOn,
    );
    if (next === null) return;
    // Ours from here on — including a refused move, which must still not let
    // ArrowDown scroll the surrounding popover.
    event.preventDefault();

    // Movement onto an out-of-bounds day is REFUSED rather than clamped or
    // skipped past: the bounds are a contiguous range, so there is never a hole
    // to jump over, and stopping at the end is what every other range control
    // does. Focus stays exactly where it was.
    if (!isDayInBounds(next, min, max)) return;

    setFocusedDay(next);
    if (!isSameMonth(next, viewMonth)) goToMonth(next);
    pendingFocus.current = toISODay(next);
  }

  // DOM focus moves AFTER the state commit, because crossing a month boundary
  // re-renders the entire grid — the button to focus may not exist yet when the
  // key is handled. Keyed off `data-day` rather than a ref map so it stays a
  // single lookup that survives that wholesale re-render. No dependency array:
  // the pending ref is the guard, and it is cleared as it is consumed.
  useLayoutEffect(() => {
    const iso = pendingFocus.current;
    if (iso === null) return;
    focusElement(
      gridRef.current?.querySelector<HTMLElement>(`[data-day="${iso}"]`),
      { reveal: true },
    );
    pendingFocus.current = null;
  });

  return (
    <Stack gap="xs" className={className}>
      <Line>
        <IconButton
          icon={chevronLeftIcon}
          label="Previous month"
          onClick={() => goToMonth(addMonths(viewMonth, -1))}
        />
        <Fill>
          <Center axis="horizontal">
            <Text variant="label" id={titleId}>
              {monthTitle(viewMonth, locale)}
            </Text>
          </Center>
        </Fill>
        <IconButton
          icon={chevronRightIcon}
          label="Next month"
          onClick={() => goToMonth(addMonths(viewMonth, 1))}
        />
      </Line>

      <ControlSizeProvider size="sm">
        {/* `role="grid"` is honest here: every child below is a `role="row"`,
            the weekday strip is a real `columnheader` row, and each day sits in
            a `gridcell`. Each week is its OWN `Grid cols={7}` — the columns
            still line up because every row has identical `repeat(7, …)` tracks
            in a container of identical width. Giving one flat grid's rows
            `display: contents` would be the other way to get rows, and is
            rejected: several screen readers drop roles on `display:contents`
            elements, which is exactly the "grid with no rows" bug this
            structure exists to fix. */}
        <Stack
          gap="none"
          role="grid"
          aria-labelledby={titleId}
          onKeyDown={handleKeyDown}
          ref={gridRef}
        >
          <Grid cols={7} gap="none" role="row">
            {headings.map((heading) => (
              <Center
                key={heading.long}
                role="columnheader"
                aria-label={heading.long}
              >
                <Text variant="caption" tone="muted">
                  {heading.short}
                </Text>
              </Center>
            ))}
          </Grid>

          {weeks.map((week) => (
            <Grid cols={7} gap="none" role="row" key={toISODay(week[0]!)}>
              {week.map((day) => {
                const selected = value != null && isSameDay(day, value);
                const disabled = !isDayInBounds(day, min, max);

                return (
                  // `aria-selected` lives on the CELL, not the button: it is the
                  // grid's own selection carrier, and a day is a selected cell
                  // rather than a pressed toggle (the `aria-pressed` this
                  // replaces). The cell keeps the `Center` box it already was —
                  // a plain `div` between `row` and `gridcell` would break the
                  // owned-element chain, and moving the role onto the button
                  // would cost its native "button" announcement.
                  <Center
                    key={toISODay(day)}
                    role="gridcell"
                    aria-selected={selected}
                  >
                    <Button
                      aspect="icon"
                      shape="pill"
                      variant={selected ? "default" : "ghost"}
                      disabled={disabled}
                      aria-label={dayLabel(day, locale)}
                      aria-current={isSameDay(day, today) ? "date" : undefined}
                      // Exactly one day is in the tab order, so entering the
                      // calendar costs one Tab instead of 42; the arrows do the
                      // rest.
                      tabIndex={isSameDay(day, activeDay) ? 0 : -1}
                      data-day={toISODay(day)}
                      onClick={() => pick(day)}
                      className={cn(
                        !isSameMonth(day, viewMonth) &&
                          "text-muted-foreground/60",
                        // Today reads as a ring so it survives the selected fill
                        // being applied to a different cell. `aria-current`
                        // above is its announced counterpart.
                        isSameDay(day, today) &&
                          !selected &&
                          "ring-1 ring-primary",
                      )}
                    >
                      {day.getDate()}
                    </Button>
                  </Center>
                );
              })}
            </Grid>
          ))}
        </Stack>
      </ControlSizeProvider>
    </Stack>
  );
}
