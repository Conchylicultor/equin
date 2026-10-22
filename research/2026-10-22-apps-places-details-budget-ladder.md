# Places: rich details on the budget ladder + Google Maps usage readout

Track: Universal search (page block-ef922c48-b280-4db9-861a-f60d99c7c5b2), last open item.

## Context

`google-maps/usage` counts every Places call per SKU and month, and the search bar already
steps down a ladder when a budget runs out (`places-core`'s `searchRung`: Text Search
Enterprise → Pro → autocomplete names, with "Ratings paused until …" in the panel). Two gaps
remain:

1. **The place card's rich details ignore their budget.** `place-details/server/internal/details.ts`
   `loadPlaceDetails` always calls `placeRichDetails` with `PLACE_RICH_DETAILS_FIELD_MASK`, which
   bills as **Place Details Enterprise + Atmosphere** (`editorialSummary`), budget 950/month. Past
   it, every card opened is billed. The photo bytes behind the card (`handle-photo.ts`) and the
   gallery thumbnails (`thumbnail.ts`) are **Place Photo**, also budget 950, and also unchecked.
2. **No readout.** Settings → Accounts → Google Maps shows the key rows (Places API key, Live map)
   but nothing says how much of this month's allowance is used. The budgets are only editable as raw
   numbers in Settings → Config.

## Design

### 1. One ladder primitive, two ladders (usage/core)

The search ladder hand-codes its rungs and SKUs. Lift that into a generic helper in
`integrations/google-maps/plugins/usage/core`:

```ts
/** The first rung whose SKU is within budget, else the floor (always free). */
budgetRung<R>(ladder: readonly { rung: R; sku: PlacesSku }[], floor: R,
              withinBudget: (sku: PlacesSku) => boolean): R
```

`searchRung` becomes `budgetRung(SEARCH_LADDER, "names", …)` (behaviour unchanged, its test
kept). The details ladder is the second user.

### 2. Rich details tiers, SKU derived from the mask (places-api)

- Move the rich masks to `places-api/core` as one table `RICH_DETAILS_MASKS: Record<RichDetailsTier, string>`:
  - `full` — today's mask (Enterprise + Atmosphere: summary included)
  - `no-summary` — same minus `editorialSummary` (Enterprise: rating, hours, price, phone, website, photos)
  - `photos` — `id,photos` (IDs only, **free**) — today's `PLACE_PHOTOS_FIELD_MASK`, reused
- `richDetailsSku(tier) = skuFor("place-details", RICH_DETAILS_MASKS[tier])` — the ladder names
  the SKU through the mask, so a field added to a mask moves its rung's SKU with it (no second list
  to keep in sync).
- `placeRichDetails(client, placeId, tier)` — `tier` is required (no default that silently bills
  the top tier). `PlaceRichDetailsSchema` fields are already optional, so every tier parses.

### 3. The details ladder (place-details)

- `place-details/core`: `DETAILS_LADDER` (`full` → `no-summary`, floor `photos`) and
  `detailsRung(withinBudget)` over `budgetRung`.
- `PlaceDetailsResult`'s `ok` arm gains `tier` and, when downgraded, `resumesAt` (the month's
  `resetsAt`) — the same shape the search answer carries, so the card can say why it is thinner.
  Plus `photosPaused: boolean` when the Place Photo budget is spent: the answer then carries no
  photo names, so the card never draws a strip of images that cannot load.
- `loadPlaceDetails`: read `mapsBudgetNow()` (the server-side twin already used by Ask Sonnet's
  tool), pick the tier, fetch. The day memo is keyed by `(placeId, tier)` — a richer answer kept
  from earlier in the day is still served (it costs nothing), but a downgraded one is not served
  once the month resets.
- `handle-photo.ts` / `thumbnail.ts`: refuse when Place Photo is spent — photo route `429`
  ("this month's free photo quota is used"), thumbnail answers a non-cached `no-photo` (not
  written as `.none`, so it comes back next month). Backstop for a card that still holds names
  from a kept answer.

### 4. The card says so (places-map)

`place-card.tsx` / `google-place-card.tsx`: when `tier !== "full"` or photos are paused, one muted
caption under the facts, worded like the search panel's ("Ratings and hours paused until Nov 1 ·
this month's free Google quota is used" for `photos`; "Summary paused until …" for `no-summary`).
`untilDay` moves out of `universal-search.tsx` into a shared places-map helper.

### 5. Usage readout in Settings → Accounts → Google Maps (usage/web)

`google-maps/usage/web` contributes an `Auth.Integration` row — the existing slot for a Google Maps
row that is not a key (as Live map does), so no new slot and no edit to auth:

- **Row**: "Usage this month", service "Google Maps", `useStatus` from `useMapsBudget` +
  counts: `Within budget` (success) / `N downgraded` (warning) / loading / error as states.
- **Pane body**: a `DataView` (list/table) over one row per budgeted SKU (from `BUDGET_FIELD`, its
  label from the config field): calls / budget, a small meter, state (`ok` / `near` ≥ 80% /
  `spent`), and what spending it does ("search drops ratings", "card drops hours"…, carried as a
  `consequence` string beside each field in `usage/core`). Header line: "Resets Nov 1 (Pacific
  time)". Budgets editable inline with the existing config field editor if config_v2 exposes one
  for a single descriptor; otherwise a link to Settings → Config `google-maps-usage`.
- IDs-only SKUs (no cap) are listed only when called this month, as "free".

## Files

- `plugins/integrations/plugins/google-maps/plugins/usage/core/usage.ts` (+ `budget-rung.ts`, test)
- `plugins/integrations/plugins/google-maps/plugins/usage/web/` (integration row + pane component)
- `plugins/integrations/plugins/google-maps/plugins/places-api/core/internal/rich-details.ts`, `server/internal/{field-mask,rich-details}.ts`
- `plugins/apps/plugins/places/plugins/places-core/core/internal/search-rung.ts` (onto `budgetRung`)
- `plugins/apps/plugins/places/plugins/place-details/{core/internal/resources.ts, server/internal/{details,handle-photo,thumbnail}.ts}`
- `plugins/apps/plugins/places/plugins/places-map/web/components/{place-card,google-place-card,universal-search}.tsx`
- CLAUDE.md of `usage` and `place-details` (the "not yet downgraded" sentence goes)

## Verification

- Unit: `budgetRung` (first in-budget rung, floor, new month), `detailsRung`, `richDetailsSku`
  per tier (full → enterprise-atmosphere, no-summary → enterprise, photos → ids).
  `./singularity test plugins/integrations/plugins/google-maps plugins/apps/plugins/places`.
- Live, on the worktree DB: set `placeDetailsEnterpriseAtmosphere` to 0 in Settings → Config,
  open a card → no summary, caption shown, `google_maps_usage` row for
  `place-details-enterprise` increments (`query_db`); set Enterprise to 0 too → photos only,
  `place-details-ids` increments; Place Photo to 0 → no strip. Screenshot each with
  `screenshot.ts`.
- Settings → Accounts → Google Maps → Usage this month: rows match `google_maps_usage`, a spent
  SKU reads `spent`, the row badge reads `N downgraded`; screenshot.
- `./singularity build` green (checks included).
