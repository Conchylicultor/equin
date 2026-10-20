import { EVENT_NAME_PATTERN, EVENT_PROP_KEY_PATTERN } from "./collect-body";

/**
 * The `event_prop` dimension's value: one prop of one event, spelled
 * `<event>.<key>=<value>` — `foundations_card_open.card=Agent manager`.
 *
 * Unambiguous because an event name and a prop key are both
 * `[a-z0-9_]` (neither holds `.` nor `=`), so the first `.` ends the event and
 * the first `=` after it ends the key; the value is everything after.
 *
 * `aggregate-sql.ts` builds the same spelling in SQL; the parity is pinned by
 * `analytics.db.test.ts`.
 */
export function eventPropValue(event: string, key: string, value: string) {
  return `${event}.${key}=${value}`;
}

export interface EventProp {
  event: string;
  key: string;
  value: string;
}

/** The parts of an `event_prop` value. Throws on a value not built by {@link eventPropValue}. */
export function parseEventPropValue(stored: string): EventProp {
  const dot = stored.indexOf(".");
  const eq = stored.indexOf("=", dot + 1);
  const event = stored.slice(0, dot);
  const key = stored.slice(dot + 1, eq);
  if (
    dot === -1 ||
    eq === -1 ||
    !EVENT_NAME_PATTERN.test(event) ||
    !EVENT_PROP_KEY_PATTERN.test(key)
  ) {
    throw new Error(
      `analytics: ${JSON.stringify(stored)} is not an event_prop value`,
    );
  }
  return { event, key, value: stored.slice(eq + 1) };
}
