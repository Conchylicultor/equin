import type { ReactNode } from "react";
import {
  clockFieldTicks,
  clockFieldValue,
  type ClockForm,
} from "@plugins/network/plugins/live/core";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";

/** How often an open clock cell redraws: a second, the finest unit a duration shows. */
const TICK_MS = 1000;

function Ticking({
  form,
  row,
  render,
}: {
  form: ClockForm;
  row: object;
  render: (value: number | null) => ReactNode;
}): ReactNode {
  const now = useNow(TICK_MS);
  return render(clockFieldValue(form, row, now));
}

/**
 * A clock field's cell (`clockField`, network/live): its value computed from
 * the row's own inputs by the field's one declaration — against a clock
 * ticking every second while the value moves with it (a run still going),
 * once otherwise. The server never sends it.
 */
export function ClockCell({
  form,
  row,
  render,
}: {
  form: ClockForm;
  row: object;
  render: (value: number | null) => ReactNode;
}): ReactNode {
  return clockFieldTicks(form, row) ? (
    <Ticking form={form} row={row} render={render} />
  ) : (
    render(clockFieldValue(form, row, 0))
  );
}
