import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { durationField } from "@plugins/fields/plugins/duration/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import {
  BROWSER_FAMILIES,
  CHANNELS,
  DEVICE_FAMILIES,
  MAX_SESSION_HITS,
  MAX_SESSIONS_LIMIT,
  OS_FAMILIES,
  SESSIONS_PAGE,
  SessionHitSchema,
  type Session,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";

// One visit of a deployed site, as the Sessions tab lists it. The labelled
// fields are what it filters, groups and searches on — every one run by
// collect's own SQL on this computer's copy of the site's tables; the rest
// ride on the row for the lane and the timeline.
const SESSION_FIELDS = {
  /** Which site — the scope every read names (`clause("deploymentId", "eq", id)`). */
  deploymentId: textField({ label: "Site" }),
  startedAt: dateField({ label: "Started" }),
  country: nullable(textField({ label: "Country" })),
  channel: enumTextField(CHANNELS, { label: "Channel" }),
  device: enumTextField(DEVICE_FAMILIES, { label: "Device" }),
  browser: enumTextField(BROWSER_FAMILIES, { label: "Browser" }),
  os: enumTextField(OS_FAMILIES, { label: "OS" }),
  language: nullable(textField({ label: "Language" })),
  returning: boolField({ label: "Returning" }),
  /** The visit came from a device the site's owner marked as theirs (collect's `audience.ts`). */
  owner: boolField({ label: "Your own visit" }),
  entryPath: textField({ label: "Entry page" }),
  exitPath: textField({ label: "Exit page" }),
  referrerHost: nullable(textField({ label: "Referrer" })),
  utmSource: nullable(textField({ label: "UTM source" })),
  utmMedium: nullable(textField({ label: "UTM medium" })),
  utmCampaign: nullable(textField({ label: "UTM campaign" })),
  pageviews: intField({ label: "Pages viewed" }),
  events: intField({ label: "Actions" }),
  durationMs: durationField({ label: "Duration" }),
  /** The distinct paths the visit hit (the report's `page` dimension). */
  pages: stringListField({ label: "Pages" }),
  /** The distinct custom events it sent (the report's `event` dimension). */
  eventNames: stringListField({ label: "Events" }),
};

const SESSION_CARRIED = {
  /** `<deploymentId>/<visit id>`: a visit id is unique within one site's tables only. */
  key: textField(),
  id: textField(),
  visitor: textField(),
  day: textField(),
  lastAt: textField(),
  live: boolField(),
  host: textField(),
  exitAt: textField(),
  exitEngagedMs: intField(),
  engagedMs: intField(),
  referrerPath: nullable(textField()),
  hits: jsonField({
    schema: cappedList(SessionHitSchema, { max: MAX_SESSION_HITS }),
  }),
  hitsTruncated: boolField(),
};

/**
 * A deployed site's visits, read from this computer's copy of its analytics
 * tables (`apps/deploy/site-mirror`) — every question one site's
 * (`clause("deploymentId", "eq", id)`, required: the copy is per site), newest first,
 * cut on `(startedAt, key)`. Served external (`server/internal/served.ts`)
 * by collect's own visit-list SQL run on the copy, and re-read whenever a
 * pull applies a page to it.
 */
export const deploymentSessions = liveCollection("deploy-analytics.sessions", {
  fields: SESSION_FIELDS,
  carry: { fields: SESSION_CARRIED },
  id: "key",
  sortable: ["startedAt"],
  default: { orderBy: [["startedAt", "desc"]], limit: SESSIONS_PAGE },
  maxLimit: MAX_SESSIONS_LIMIT,
  count: true,
});

/** One row of {@link deploymentSessions}. */
export type SessionRow =
  typeof deploymentSessions extends LiveRowsCollection<infer R> ? R : never;

/** The key of a site's visit: unique across every site's copy. */
export function sessionKey(deploymentId: string, visitId: string): string {
  return `${deploymentId}/${visitId}`;
}

/** A key's two parts — throws on a key {@link sessionKey} never spells. */
export function parseSessionKey(key: string): {
  deploymentId: string;
  visitId: string;
} {
  const slash = key.lastIndexOf("/");
  if (slash <= 0 || slash === key.length - 1)
    throw new Error(`deploy-analytics.sessions: malformed key ${key}`);
  return { deploymentId: key.slice(0, slash), visitId: key.slice(slash + 1) };
}

/** A collect visit as a row of {@link deploymentSessions}. */
export function sessionRowOf(deploymentId: string, s: Session): SessionRow {
  return {
    ...s,
    key: sessionKey(deploymentId, s.id),
    deploymentId,
    startedAt: new Date(s.startedAt),
  };
}

/** A row as the collect visit the lane and the timeline draw. */
export function sessionOf(row: SessionRow): Session {
  const { key: _key, deploymentId: _site, startedAt, ...rest } = row;
  return { ...rest, startedAt: startedAt.toISOString() };
}

/** The row schema's `startedAt`: a `$key` part spelled as `toISOString()` (fixed width, so code-point order is time order). */
export const startedAtKeyText = (startedAt: Date): string =>
  startedAt.toISOString();
