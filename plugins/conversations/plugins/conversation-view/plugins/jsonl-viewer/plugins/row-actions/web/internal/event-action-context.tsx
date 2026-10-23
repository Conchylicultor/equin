import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { JsonlRowActions } from "../slots";

const EventActionContext = createContext<{
  event: JsonlEvent;
  inert: boolean;
} | null>(null);

/**
 * `inert`: the row is a stand-in for a line the transcript does not hold yet,
 * so its actions would act on nothing — the strip is still drawn (the row lays
 * out exactly as it will once the real row takes over) but takes no input. The
 * rest of the row stays live: a stand-in card still opens.
 */
export function EventActionProvider({
  event,
  inert = false,
  children,
}: {
  event: JsonlEvent;
  inert?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ event, inert }), [event, inert]);
  return (
    <EventActionContext.Provider value={value}>
      {children}
    </EventActionContext.Provider>
  );
}

/**
 * The universal row actions (timestamp, copy, …, and the ⋯ the slot's config
 * folds raw JSON and the text toggles into) for one transcript event. This
 * plugin owns WHICH actions a row carries — the per-event context and the
 * `JsonlRowActions.Item` contributions — and nothing else: the
 * reveal, the click/pointerdown guards, the popup-hold and the control size all
 * belong to the shared `primitives/row-actions` cluster, so a transcript row
 * behaves exactly like every other row-action cluster in the app.
 *
 * `pin={null}` because the HOST places it, always in the flow so it never
 * covers the row's content: the header renderers drop it into their own
 * trailing slot, and the headerless text/image renderers render it FIRST inside
 * their text with `float`, so the prose wraps around it.
 */
export function EventRowActions({
  className,
  float,
}: {
  className?: string;
  float?: boolean;
}) {
  const ctx = useContext(EventActionContext);
  const actions = JsonlRowActions.Item.useContributions();
  if (!ctx) return null;
  if (actions.length === 0) return null;
  const { event, inert } = ctx;
  const strip = (
    <RowActions pin={null} float={float} className={className}>
      <JsonlRowActions.Item.Render>
        {(item) => <item.component event={event} />}
      </JsonlRowActions.Item.Render>
    </RowActions>
  );
  // `contents`: the wrapper draws no box, so the strip floats / sits in its
  // track exactly as it does on a real row.
  return inert ? (
    <div inert className="contents">
      {strip}
    </div>
  ) : (
    strip
  );
}
