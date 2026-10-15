# mapstr-import

`./singularity places import-mapstr <path>` — moves a Mapstr export into the
Places app. `<path>` is `mapstr.zip` or the folder it extracts to
(`mapstr.csv` + `mapstr.geojson`, joined by row order; names must agree). The
command boots this checkout's backend in `exec` mode, so it reads and writes
**this checkout's** DB with its Maps key; build the checkout once first.

## Two phases

1. **Match** (default — no DB write). Per place, Google Text Searches biased
   to the Mapstr pin (250 m), each only while the place is still unmatched:
   `"<name>, <address>"`; the same in the language its address implies
   (`languageForAddress`, a closed table — Google otherwise answers "Bourdelle
   Museum" for "Musée Bourdelle"); then the name alone, in both languages (the
   address search often finds only the street). `pickCandidate` (`match.ts`)
   scores every hit of every search — folded, typo-tolerant tokens,
   abbreviations spelt out, generic words and the city dropped — and takes one
   on a basis:
   - `name`: a `MATCH_TIERS` tier — a similar name within 150 m, farther only
     when Google's name says nothing the user's does not ("PETIT marché de
     Rungis" is another place). A street-level address ("108 Rue Saint-Maur")
     only when the user saved that address.
   - `area`: a town, park, road or country whose viewport (or type radius)
     holds the pin, named the user's way — however far its point.
   - `translation`: the first hit of a name-only search, a big area holding the
     pin ("Portogallo" → "Portugal", "Lago di Garda" → "Lake Garda"). Never a
     mere park: a garden's name may find the garden next door first.

   Car parks never match. Otherwise *unmatched*, the reason naming the nearest
   (or most alike) hit and its id.

   Every search is stored in `mapstr-matches.json` (next to the zip, inside the
   folder, or `--out`; tied to the export by the CSV's sha256), so a re-run
   re-scores for free and searches only what is missing; `--rescore` never
   searches; `--refresh` discards stored searches (never overrides). A Google
   failure mid-run still writes what was searched; a 429 waits out the
   per-minute quota. Two rows resolving to one Google place are reported as duplicates.

   **Hand decisions**: find ids with `./singularity places search-place "<query>"
   [--near <lat>,<lng>] [--lang <code>] [--radius <m>]` (read-only, top 10 with
   address, types, distance, business status), then `--overrides <file.json>`,
   an array of entries, each exactly one of (`.strict()` — an entry naming two
   kinds is refused):

   ```jsonc
   // A Google place, optionally shown under the user's own title.
   { "index": 954, "googlePlaceId": "ChIJ…", "title": "Japantown", "note": "evidence" }
   // No Google place (closed, an event, a bunker): a custom place. The pin
   // defaults to the Mapstr row's; give lat AND lng to move it.
   { "index": 12, "custom": { "name": "Bunker", "lat": 52.5, "lng": 13.4 }, "note": "evidence" }
   // The user chose to drop the row. `reason` is required.
   { "index": 7, "discard": true, "reason": "a one-off party, nothing to keep" }
   ```

   `title` and `note` are optional; `note` is the decision's evidence, never
   the place's note (that is the Mapstr comment). A Google id is checked with
   one Place Details call and stored with its snapshot; a custom or discard
   entry is stored as is (a custom pin with its coordinates filled in). Each
   becomes the row's `override` (`matches-file.ts`), which wins over the
   scorer and survives `--rescore` / `--refresh`; a refused id is reported and
   not recorded. Stored overrides from before titles existed (`{googlePlaceId,
   note?, snapshot?}`) still read as Google overrides.
2. **`--apply`** — never searches. Refuses a matches file from another export, or
   one with an unsearched row or an unmatched row with no override: nothing is
   left behind by accident. Discarded rows are left out and listed, with their
   reasons, at the end of the output. Rows sharing one Google place merge
   (`mergeImports`: tags united, notes kept, earliest date, the first title
   given); a row whose Google name no longer says what was saved (renamed, or
   an address standing in for a closed venue) keeps its Mapstr name as the
   note's first line — unless the place has a title, which already says it.
   Custom places never merge and get no such line (their name is the user's);
   they keep the Mapstr address. Fetches every matched place's details FIRST
   (an override's are stored already), then `replaceAllPlaces` (places-core)
   wipes places and tags, seeds the tag tree and inserts every place — Google
   or custom (`ImportedPlace.place` is places-core's `NewPlace`) — in ONE
   transaction, icon jobs enqueued on the same transaction, so a failure
   anywhere leaves the old data untouched.

## Tags

`MAPSTR_TAGS` (`cli/internal/tag-map.ts`) maps every Mapstr tag name onto a
**seed key** (`SeedTagKey`, places-core), never a display name: `.Done` → Been,
`.Todo` → Want to go, `To Try` dropped, `Food/Bar` → the Bar child only. A tag
the table does not know fails the import before any Google call. Mapstr's icon,
rating and photos are not carried over; its comment becomes the note and its
save date `createdAt`.

## Cost

Text Search with `SEARCH_TEXT_FIELD_MASK` (id, name, location, types, address,
viewport, business status) is the **Text Search Pro** SKU — no Enterprise field;
`--apply` makes one Place Details Pro call per matched place. ~1k of each for a
typical export.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: `./singularity places import-mapstr <export>` — matches a Mapstr export's places to Google places (Text Search, scored by name, distance and area extent; hand decisions via --overrides and the search-place lookup verb) into a reviewable mapstr-matches.json, then with --apply replaces every place and tag with the seed tree and the matched places (Mapstr tags mapped onto seed tags, comments as notes, original save dates), in one transaction.
- Cli:
  - Uses: `framework/server-core.runExec`

<!-- AUTOGENERATED:END -->
