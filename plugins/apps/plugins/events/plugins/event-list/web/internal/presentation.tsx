import type { ReactNode } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import {
  eventsEntityRef,
  externalUrl,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import {
  NewTabGlyph,
  newTabAnchorProps,
} from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { formatEventWhen, urlHost } from "./format";

// How the events entity's fields present in every list of events: registered
// once against the entity (`FieldPresentation.Register({ owner:
// eventsEntityRef })`, `../index.ts`), so no list builds them. A field with no
// presentation here takes its type's cell (`disappearedAt` — a provenance
// stamp — is a relative time, exactly right there).

/**
 * External link chip: the host, opening the event's own page in a new tab.
 *
 * The href passes `externalUrl` (absolute `http(s)` only) — a scraped, model-written
 * value is never handed to the DOM as a destination unguarded. The click stops
 * propagating (newTabAnchorProps) because the row around it is itself activatable
 * (it opens the same page, or the source's when the event has none): without
 * this, clicking the chip would open two tabs.
 */
function UrlCell({ url }: { url: string | null }): ReactNode {
  const href = externalUrl(url);
  const host = href === null ? null : urlHost(href);
  if (href === null || host === null) return null;
  return (
    <Badge
      as="a"
      {...newTabAnchorProps(href)}
      icon={<NewTabGlyph />}
      colorClass="bg-muted text-primary-text hover:bg-muted/80 hover:underline"
      tooltip={href}
    >
      {host}
    </Badge>
  );
}

/**
 * `startsAt` is the one date rendered ABSOLUTELY: an events list is mostly
 * forward-looking and the weekday decides whether you go, which the generic
 * relative date cell ("in 3d") cannot say. The cell reads the row's `allDay`
 * beside it (`reads`).
 */
export const eventPresentation = FieldPresentation.Register({
  owner: eventsEntityRef,
  reads: ["allDay"],
  fields: {
    startsAt: {
      cell: (startsAt, e) => (
        <Text as="span" variant="body">
          {formatEventWhen(startsAt, e.allDay)}
        </Text>
      ),
    },
    url: { cell: (url) => <UrlCell url={url} /> },
    // Search-only: a filter on it is offered, a column is not.
    description: { visible: false },
  },
});
