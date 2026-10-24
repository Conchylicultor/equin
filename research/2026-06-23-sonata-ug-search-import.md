# Sonata: search mode for Ultimate Guitar import

## Context

Today the only way to add an Ultimate Guitar song to Sonata is to paste a tab
URL into the **Import from Ultimate Guitar** dialog. That assumes the user has
already found the tab on ultimate-guitar.com and copied its URL. The natural
flow — "I want the chords for *Wonderwall*" — isn't supported.

This adds a **search mode**: the same dialog accepts free text and searches UG's
catalog, listing candidate tabs (artist, type, rating, votes) so the user can
pick the right one. Pasting a URL still works (it bypasses search and imports
directly). Everything downstream of "I have a tab URL/id" — fetch → `compile()`
→ `createSongRow` → open in player — is **unchanged**; we only add a search
endpoint and upgrade the dialog UI.

Confirmed scope decisions:
- **Smart single input** — a UG URL imports directly; free text searches.
- **Default to Chords-type** results, with a chip to widen to all types. (The
  songsheet renderer only compiles chord/lyric markup, i.e. "Chords" /
  "Ukulele Chords" types — tab/pro/bass won't render.)
- **Library import only** — no player-toolbar search this round.

All paths below are relative to
`plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/`.

## Key implementation risk: the search backend

The existing tab fetch (`server/internal/ug-client.ts → fetchUgTabContent`) hits
UG's **signed Android API** `GET api.ultimate-guitar.com/api/v1/tab/info` with
per-request `X-UG-CLIENT-ID` / `X-UG-API-KEY` headers built by the module-private
`buildAuthHeaders()` (md5 of `deviceId + date:hour + "createLog()"`).

**Approach for search: the same signed mobile API**, hitting its search route so
the whole UG integration stays on one transport and one auth scheme:

```
GET https://api.ultimate-guitar.com/api/v1/tab/search?title=<query>&page=1
```

with the identical headers (`buildAuthHeaders()` + Android `User-Agent`
`UGT_ANDROID/4.11.1 (Pixel; 8.1.0)`). `buildAuthHeaders()` is already in
`ug-client.ts`, so the new `searchUgTabContent` can call it directly — no export
change.

The exact response JSON shape is **undocumented and must be verified against a
live response** before wiring the zod schema. The expected shape (from community
clients) is a list of tab entries roughly:

```jsonc
{
  "id": 3250376,
  "song_name": "Wonderwall",
  "artist_name": "Oasis",
  "type": "Chords",            // "Chords" | "Ukulele Chords" | "Tab" | "Pro" | "Bass" | ...
  "version": 3,
  "votes": 12000,
  "rating": 4.7,
  "tonality_name": "F#m"
}
```

We only need the numeric `id` per result — the client synthesizes
`https://tabs.ultimate-guitar.com/tab/<id>` for import, which `extractUgTabId`
already resolves (bare-numeric `/tab/<id>` path). So no `tab_url` dependency.

> **Verify during implementation:** make one signed request and confirm the
> result-array key, field names, and the `title=`/`value=` query param. Adjust
> the param name and `UgApiSearchResponseSchema` to match what UG actually
> returns. Per the repo rule, **fail loudly** with a classified `UgFetchError`
> (reuse the existing taxonomy + `statusForKind`) — never silently return `[]`.
> If the search route's signing differs from `/tab/info` (e.g. a `498
> signature-rejected`), that surfaces as a loud `signature-rejected` error, not
> a silent empty list.

## Server changes

### 1. `core/raw-tab.ts` (or a new `core/search-result.ts`) — result type

Add a `UgSearchResult` schema + type, exported from `core/index.ts`:

```ts
export const UgSearchResultSchema = z.object({
  tabId: z.string(),       // numeric UG id; client builds /tab/<id> URL for import
  songName: z.string(),
  artistName: z.string(),
  type: z.string(),        // raw UG type string, e.g. "Chords", "Ukulele Chords"
  rating: z.number(),      // 0–5
  votes: z.number(),
  version: z.number().nullable(),
});
export type UgSearchResult = z.infer<typeof UgSearchResultSchema>;
```

### 2. `shared/endpoints.ts` — new endpoint (mirrors `fetchUgTab`)

```ts
export const searchUgTabs = defineEndpoint({
  route: "POST /api/sonata/sources/ultimate-guitar/search",
  body: z.object({ query: z.string() }),
  response: z.object({ results: z.array(UgSearchResultSchema) }),
});
```

Type filtering is done **client-side** on the returned `type` string (keeps the
server dumb and avoids hard-coding UG's type-id magic numbers). Server returns
all result types.

### 3. `server/internal/ug-client.ts` — `searchUgTabContent(query)`

New exported function alongside `fetchUgTabContent`, reusing `buildAuthHeaders()`,
the Android `User-Agent`, `safeFetch`, and the full `UgFetchError` taxonomy
(`network`, `upstream`, `bad-request`, `signature-rejected`,
`malformed-response`). Steps: build the `/api/v1/tab/search` URL with the
`title`/`value` query param → `safeFetch` with the same headers as
`fetchUgTabContent` → status dispatch (same as fetch: 400 → `bad-request`,
498 → `signature-rejected`, other non-2xx → `upstream`) → `res.json()` →
validate with `UgApiSearchResponseSchema` (`malformed-response` on failure) →
map to `UgSearchResult[]` (drop entries without a numeric `id`). Factor the
shared header-building + status-dispatch out of `fetchUgTabContent` if it reduces
duplication, but a straight mirror is acceptable.

### 4. `server/internal/routes.ts` — `handleSearchUgTabs`

Mirror `handleFetchUgTab` exactly, including the `UgFetchError → HttpError`
translation via the existing `statusForKind`:

```ts
export const handleSearchUgTabs = implement(searchUgTabs, async ({ body }) => {
  try {
    return { results: await searchUgTabContent(body.query) };
  } catch (err) {
    if (err instanceof UgFetchError) throw new HttpError(statusForKind(err.kind), err.message);
    throw err;
  }
});
```

### 5. `server/index.ts` — register the route

Add `[searchUgTabs.route]: handleSearchUgTabs` to `httpRoutes`.

## Web changes

### 6. `web/components/ug-import-dialog.tsx` — smart input + results list

Rework the dialog (keep the `openDialog((close) => <UgImportDialog onClose={close} />)`
entry point in `ug-create-option.tsx` untouched). New behavior:

**Input.** Replace the bare `<input type="url">` with `SearchInput`
(`@plugins/primitives/plugins/search/web`), `autoFocus`, placeholder
`"Search songs or paste a tab URL…"`.

**Mode detection.** `looksLikeUgUrl(query)` = try `extractUgTabId(query)` in a
`try/catch` (it's in `core`, importable on web).
- **URL mode** → no list; show a single primary **Import this tab** button that
  calls `importByUrl(query.trim())`.
- **Search mode** (non-empty, not a URL) → debounce 150 ms (inline the 8-line
  `useDebouncedValue` helper — the one in `quick-find/use-search.ts` is private),
  then `fetchEndpoint(searchUgTabs, {}, { body: { query } })` inside an effect
  guarded by an `AbortController`. Store `{ results, loading, error }`.

**Type filter chip row.** A `SegmentedControl` (from
`@plugins/primitives/plugins/css/plugins/toggle-chip/web`) with `Chords` |
`All types`, default `Chords`. Filtering is client-side: `Chords` keeps results
whose `type` **contains** `"Chords"` (covers both "Chords" and "Ukulele Chords",
the two that compile to a songsheet). `All types` shows everything.

**Results list.** For each filtered result render a `Row`
(`@plugins/primitives/plugins/css/plugins/row/web`):
- `icon`: `MdMusicNote`
- children: song name (`<Text>` bold) + artist (muted) + a `Badge`
  (`@plugins/primitives/plugins/css/plugins/badge/web`) for `type` +
  trailing `★{rating} · {votes}` (and `v{version}` when present)
- `onClick`: `importByResult(result)` → `importByUrl(`https://tabs.ultimate-guitar.com/tab/${result.tabId}`)`
- Loading state: `<Loading variant="rows" />`
  (`@plugins/primitives/plugins/loading/web`); settled-empty:
  `<Placeholder>No results.</Placeholder>`.

**Per-row import progress.** Track `importingId`; the clicked `Row` shows a
`Spinner` and the list disables while fetch→compile→create runs (a UG fetch +
create is a visible round-trip).

**Refactor the import flow** out of the current `importTab` into a reusable
`importByUrl(url)` (unchanged logic — `fetchUgTab` → `compile` → `scoreEndBeat`
→ `createUltimateGuitarSong` → `onClose()` → `openSongImperative(song)`). Both
URL mode and result selection funnel through it, preserving the fetch-first /
no-orphan-songs guarantee. Errors surface in the existing `role="alert"` span.

**Optional polish** (mirror `QuickFindDialog`): arrow-up/down to move an active
row, `Enter` to import the active result.

No changes to `web/loader.tsx`, `web/compile.ts`, the in-player editor section,
or any DB schema.

## Files touched

| File | Change |
|---|---|
| `core/raw-tab.ts` / `core/index.ts` | add `UgSearchResultSchema` / `UgSearchResult`, export |
| `shared/endpoints.ts` | add `searchUgTabs` endpoint |
| `server/internal/ug-client.ts` | add `searchUgTabContent(query)` |
| `server/internal/routes.ts` | add `handleSearchUgTabs` |
| `server/index.ts` | register `[searchUgTabs.route]` |
| `web/components/ug-import-dialog.tsx` | smart input + results list + `importByUrl` refactor |

Reused as-is: `extractUgTabId`, `UgFetchError`/`statusForKind`, `safeFetch`,
`fetchUgTabContent`, `compile`/`scoreEndBeat`/`beatToSeconds`,
`createUltimateGuitarSong`, `openSongImperative`, `openDialog`, and the
primitives `SearchInput` / `Row` / `Badge` / `SegmentedControl` / `Loading` /
`Placeholder` / `Text` / `fetchEndpoint`.

## Verification

1. `./equin build` from the worktree; open
   `http://<worktree>.localhost:9000/sonata`.
2. **Search mode:** `+` → *Import from Ultimate Guitar* → type `wonderwall`.
   Expect a debounced list defaulting to Chords-type, each row showing
   artist + type badge + rating/votes. Toggle **All types** and confirm
   tab/pro/bass results appear.
3. Click a Chords result → it imports and opens in the player with the
   chord-over-lyrics songsheet rendering correctly.
4. **URL mode:** reopen, paste `https://tabs.ultimate-guitar.com/tab/3250376` →
   the list is replaced by a single **Import this tab** button; clicking it
   imports the exact tab (regression check on the original behavior).
5. **Failure loudness:** search a nonsense string → settled "No results";
   simulate an upstream failure → the `role="alert"` span shows a classified
   error message (no silent empty list).
6. **Before finalizing the schema:** make one signed `/api/v1/tab/search`
   request (reuse `buildAuthHeaders()`) and confirm the result-array key, field
   names, and query param (`title=` vs `value=`); set `UgApiSearchResponseSchema`
   to match. If signing is rejected (498), surface it loudly rather than
   silently returning no results.

## Out of scope / follow-ups

- Player-toolbar "swap song" search (deferred by decision).
- Pagination / infinite scroll of results (first page is enough; note the cap in
  the UI if results are truncated).
- A reusable `useDebouncedValue` primitive — currently private in `quick-find`;
  inlined here. Worth extracting later if a third consumer appears.
