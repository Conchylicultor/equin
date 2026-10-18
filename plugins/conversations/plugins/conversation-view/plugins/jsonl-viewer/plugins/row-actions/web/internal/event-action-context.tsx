import { createContext, useContext, type ReactNode } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { JsonlRowActions } from "../slots";

const EventActionContext = createContext<JsonlEvent | null>(null);

export function EventActionProvider({
  event,
  children,
}: {
  event: JsonlEvent;
  children: ReactNode;
}) {
  return (
    <EventActionContext.Provider value={event}>
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
  const event = useContext(EventActionContext);
  const actions = JsonlRowActions.Item.useContributions();
  if (!event) return null;
  if (actions.length === 0) return null;
  return (
    <RowActions pin={null} float={float} className={className}>
      <JsonlRowActions.Item.Render>
        {(item) => <item.component event={event} />}
      </JsonlRowActions.Item.Render>
    </RowActions>
  );
}
