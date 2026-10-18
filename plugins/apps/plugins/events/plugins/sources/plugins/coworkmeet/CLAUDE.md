# coworkmeet

The free coworking sessions of [coworkmeet.fr](https://www.coworkmeet.fr/), read
from the association's own database. CoworkMeet is a Paris *association loi 1901*
that books cafés and hotel lobbies and opens them to freelances, to fight the
professional isolation of working alone — the sessions are free, and the point of
them is the other people in the room. Hence `category: "community"`, which is
what that arm of the closed vocabulary means (`salsanueva` justifies its `sport`
the same way).

The site is a Next.js SPA and its listing is fetched client-side, so the generic
`url` type is handed an empty shell and truthfully extracts nothing.

## Reading the association's database directly

`GET https://zouzqrendnialuqtmorh.supabase.co/rest/v1/coworking_sessions` — the
call the site's own page makes. It is a **Supabase (PostgREST)** table, so the
"API" is the table: the columns are named in `select`, the filters are
`published=eq.true&deleted=eq.false&cancelled=eq.false`, and the sign-up count
comes back as the embedded aggregate `session_registrations(count)`, which is an
ARRAY holding one object (`[{ "count": 13 }]`) because an embedding is a relation
even when it is aggregated to one row.

**The anon key in `probe.ts` is a public credential, not a secret.** It is
shipped in the site's browser bundle, every visitor sends it, and what it may
read is decided by Postgres row-level security on the far side. So it is
hardcoded, exactly as `dmda` hardcodes its endpoint — routing it through the
secrets store would imply a per-user value that does not exist.

Paging is by `limit`/`offset`, and the whole-set guarantee comes from the
`Content-Range: 0-66/67` header that `Prefer: count=exact` asks for. A missing or
inexact total is terminal: the total is the only thing that says the listing was
read whole, and a truncated read is not a shorter listing — every session past
the cut would be absent from `extract`'s full set, which is exactly what the
engine stamps `disappearedAt` on.

## The arrondissement is published twice, and neither half is complete

The `arrondissement` column is filled on **14 of 67** live sessions. The address
carries a `75xxx` postcode on **51 more**. Measured across the whole capture the
two **never disagree** — they are complementary, not competing — so reading the
column first and falling back to the postcode answers **65 of 67**. The two that
resolve to nothing are genuine: `30 Rue du Sentier` names no postcode at all, and
one session is in Pantin, which has no arrondissement to name.

One trap worth keeping: the postcode pattern takes **three** digits
(`\b75(\d{3})\b`), then range-checks 1–20. The tempting `\b75(\d{2})\b` reads
`75005` as district 50, which fails the range check, so the 5th arrondissement
silently disappears.

## The filter's option IS the tag

`core/internal/catalog.ts` holds the association's own five vocabularies —
session type, district, ambiance, noise, power outlets — as `{ code, label }`
pairs. **The label is both the value a filter selects and the tag the extractor
emits.** That is what makes a source's filters and the events DataView's tag
dimension agree: tick `Silencieux` on the source and the events it publishes
carry `Silencieux`, so the same word filters in both surfaces.

It is structural, not a convention: the config fields take their options from
`facetLabels(catalog)` and the extractor takes its tags from
`facetLabelOf(catalog, code)`, so a tag that is not an option cannot be spelled.
`facets.test.ts` pins it against the one way it could still break — someone
re-typing a label at either end.

A session the association did not rate carries no word on that dimension, and so
does not match a filter on it. That is the honest reading — a filter on "quiet
venues" cannot include one nobody rated — and every rating filter's description
says so.

## Deliberately NOT filtering on `archived`

The table has an `archived` boolean and **the site's own listing filters on it**.
This type does not, on purpose. Measured against the live data, `archived` is an
inconsistently-applied housekeeping flag rather than a "this is in the past"
marker: the 2025 sessions are archived while dozens of already-past 2026 ones are
not. Filtering on it would mean an upstream tidying sweep deletes
previously-published events out of *our* listing, and the engine stamps
`disappearedAt` on every one of them. So the query filters on the flags that say
something about the session itself — `published`, `deleted`, `cancelled` — and
ignores the one that says something about the association's admin.

## Three things that look wrong and aren't

- **The fingerprint covers every field this type reads, the sign-up count
  included** — the opposite call from `dmda`, which hashes identity fields only.
  Two reasons it can afford it: nothing here churns per request (`dmda`'s
  `picture` is a signed blob URL that changes on every fetch), and `extract`
  costs no model call. So a false "changed" buys a few milliseconds of mapping,
  while a false "unchanged" would hide a real edit — a venue's note, a price, one
  more person signed up — until something else moved.
- **`price` is `"Free"`, even when `prix_conso` is set.** `prix_conso` is what a
  *drink* costs at the venue, not what the session costs; the session is always
  free. It travels as an aside — `Free (drinks from €3.50)` — because an event
  reading `€3.50` would be saying the association charges for it.
- **The venue keeps its trailing spaces' worth of mess.** `Péniche Annette K `
  loses only its whitespace; `Hôtel Mercure Montparnasse****` keeps its stars and
  `Le NELSON’S` keeps its capitals. The stars are how the hotel names itself, and
  re-casing would be this plugin deciding it knows a venue's name better than the
  person who typed it.

## Paris wall clock, UTC instant

`date_session` + `heure_debut`/`heure_fin` are **Paris local time**: 14:30 in
September is 12:30 UTC and 14:30 in December is 13:30 UTC, so reading either as
UTC puts every summer session two hours early. The conversion belongs to the
shared [`packages/wall-clock`](../../../../../../../packages/plugins/wall-clock)
primitive — do not hand-roll an `Intl` offset loop here (`event-date/CLAUDE.md`
explains why there is no tz database in this repo).

An end at or before the start is read as running past midnight and rolled to the
next day, which is what an afterwork ending at 01:00 means. Reported in `flags`,
because it is a reading of ambiguous data rather than a fact the association
published — no live session needs it today.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: CoworkMeet source type in the Events `+` menu: contributes the `coworkmeet` type with its session-type / district / ambiance / noise / power-outlet filters. CoworkMeet event source type: probe reads the association's own Supabase listing of free coworking sessions (SSRF-guarded) and fingerprints every column it maps; extract turns each session into an event with no model call, tagging it with the association's own venue vocabulary and filtering on the same words.
- Web:
  - Contributes: `EventSources.Type` "CoworkMeet"
  - Uses: `apps/events/events-core.EventSources`
- Server:
  - Uses:
    - `apps/events/events-core.defineEventSourceType`
    - `infra/jobs.NonRetryableError`
    - `infra/safe-fetch.parsePublicUrl`
    - `infra/safe-fetch.safeFetch`
  - Register: `defineEventSourceType('coworkmeet')`
- Core:
  - Uses: `fields/tags/config.tagsField`
  - Exports (types):
    - `CoworkmeetFacet`
    - `CoworkmeetFilterKey`
    - `CoworkmeetSourceConfig`
  - Exports (values):
    - `COWORKMEET_AMBIANCES`
    - `COWORKMEET_DISTRICTS`
    - `COWORKMEET_FILTER_KEYS`
    - `COWORKMEET_ORIGIN`
    - `COWORKMEET_POWER_OUTLETS`
    - `COWORKMEET_QUIET_LEVELS`
    - `COWORKMEET_SESSION_TYPES`
    - `COWORKMEET_SOURCE_TYPE_ID`
    - `coworkmeetSessionUrl`
    - `coworkmeetSourceConfigFields`
    - `facetLabelOf`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/probe.ts` (debt)

<!-- AUTOGENERATED:END -->
