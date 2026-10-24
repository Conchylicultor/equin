# `/place` — an address block for Pages, on a provider registry

## Context

Pages can hold text, media, links and embeds, but not a **location**. Writing "meet at
Café Kitsuné, 51 Galerie de Montpensier" today is plain text: no canonical identity, no
link to a map, nothing an agent reading the page can resolve.

This plan adds a `/place` block: type `/place`, search for an address or business, pick
one from a dropdown, and the block becomes a card naming the place. The lookup goes
through a **provider registry** so Google Places is one contributor, not a hardcoded
dependency — OpenStreetMap can be added later as a second provider with no edit to the
block.

Three scope decisions were taken before this plan was written:

- **No map on the card in v1.** A live Google map means the Maps Embed API, whose key
  travels in the iframe URL and is therefore browser-visible. That forces a second,
  public key and a second wizard step. v1 stays at exactly **one secret key** that never
  leaves the server; the card links out to Google Maps instead. (The Embed API is free
  and unlimited, so adding the map later costs setup friction, not money.)
- **Snapshot + 30-day refresh.** The block stores the place id plus a display snapshot
  with a `fetchedAt` stamp, and silently re-resolves when the snapshot is older than 30
  days. Google's terms let `place_id` be stored indefinitely and coordinates for 30 days;
  this keeps the card instant, offline-readable and meaningful in markdown, and bounds the
  cache to the window Google names for coordinates.
- **Fix the auth API-key path generically.** See below — it is currently dead code.

## What we're building on

The block itself is the `bookmark` block's exact shape (three states keyed on data:
empty → fetching → card), so most of the editor work is a copy with a different middle.
The genuinely new work is the credential and the provider registry.

**The API-key arm of auth exists but has never been used.** `plugins/auth/core/internal/lib.ts:1`
defines `AuthProviderKind = "oauth2" | "apikey"`; `actions.setApiKey`
(`plugins/auth/central/internal/actions.ts:17-42`), the `POST /api/auth/api-key/:provider`
route, the `apiKey` field on `StoredAccount`, and the apikey branch of `getAccessToken`
(`plugins/auth/central/internal/token-access.ts:132-147`) are all implemented and generic.
But **`plugins/auth/web` contains zero references to `apiKey`**: `DefaultProviderRow`'s
only action is `startConnectFlow`, which opens the OAuth popup, which
`handleOAuthStart` (`oauth-start.ts:27-29`) rejects with HTTP 400 for a non-oauth2
provider. So an api-key provider registered today would render a Connect button that
cannot work. We fix that once, in the shared row, rather than shipping a bespoke Google
Maps row.

## Where the code lives

Split by what each piece actually *is*: auth owns the credential, integrations owns the
Google API, page owns the block. This mirrors `integrations/gmail`, whose stated rule is
that consumers "go through it and **never** import `@plugins/auth/*` directly".

```
plugins/auth/plugins/google-maps/                     the credential (kind: "apikey")
  plugins/setup-wizard/                               the guided pane

plugins/integrations/plugins/google-maps/             the broker: key access + readiness UI
  plugins/places-api/                                 stateless typed Places client

plugins/page/plugins/place/                           the block + definePlaceProvider registry
  plugins/google/                                     thin adapter: registry ⇄ places-api
```

---

## 1. `plugins/auth/plugins/google-maps/` — the credential

Copy `plugins/auth/plugins/notion/`'s layout (the minimal provider), minus its
`shared/config.ts`: an api-key provider stores nothing in config_v2. The key lives in the
auth token store, encrypted, shared across every worktree.

- `core/index.ts` — `export const GOOGLE_MAPS_PROVIDER_ID = "google-maps"`. Named once so
  the wizard, the web row and the integrations broker cannot drift onto different ids.
- `central/internal/descriptor.ts` — `defineAuthProvider({ id, name: "Google Maps Platform",
  kind: "apikey", apiKey: { pattern, help, verify } })`.
  - `pattern: /^AIza[0-9A-Za-z_-]{35}$/` — rejects an obvious paste error before any
    network call.
  - `verify(apiKey)` — **this is the wizard's Test step.** One cheap
    `places:autocomplete` POST with a fixed throwaway input. On non-200, throw with
    Google's own error text (`REQUEST_DENIED`, "API not enabled", "billing not enabled"),
    which `handleSetApiKey` turns into a 400 the wizard renders inline. On success return
    `{ accountId: "primary", displayName: "Google Maps Platform" }`. Without `verify`,
    `actions.setApiKey` stores a stub identity and any garbage string reads as "Connected"
    (`actions.ts:30-32`) — so `verify` is not optional in practice.
  - Keep this probe a self-contained ~15-line fetch in the descriptor. It is a liveness
    check, not domain logic; making central depend on `places-api` to run it would buy
    nothing and add a cross-plugin edge.
- `central/internal/register.ts` + `central/index.ts` — one `registerAuthProvider(...)`
  token listed in the plugin's `register: [...]` array, exactly as google/notion do.
- `web/index.ts` — `Auth.Provider({ id, name, icon: SiGooglemaps, helpUrl, configureCredentials:
  () => openPane(mapsSetupPane, {}, { mode: "root" }) })`. `configureCredentials` already
  exists on the slot (`plugins/auth/web/slots.ts:17`); it is what google's OAuth wizard uses.

There is **no `server/index.ts`** — nothing worktree-side to register.

### 1b. Generic api-key support in `plugins/auth/web`

One file: `plugins/auth/web/components/default-provider-row.tsx`. `useAccountStatus`
already returns `kind` (`AuthAccountState.kind`), so branch on it:

- `kind === "apikey"` → the primary button is **Add key** (not connected) or **Replace
  key** (connected), both calling `provider.configureCredentials?.()`, falling back to
  the config pane. Never `startConnectFlow`.
- The status pill for an api-key provider must read from `connected` alone.
  `credentialsConfigured` is hardcoded `true` for non-oauth2 providers
  (`auth-state.ts:11-21`), so the existing "Setup required" state can never appear; an
  unconfigured api-key provider should read **"Not set up"**.
- Disconnect is unchanged and already works.

Every future api-key provider inherits this. Two known limits stay, and are worth stating
in the row's comments rather than papering over: an api-key account is `connected: true`
from the moment it is stored and nothing ever marks it stale (the refresh loop skips
non-oauth2 providers), and Disconnect deletes the local entry without revoking anything
upstream.

### 1c. `plugins/auth/plugins/google-maps/plugins/setup-wizard/`

Structurally identical to `plugins/auth/plugins/google/plugins/setup-wizard/` — read
`research/2026-05-04-auth-google-setup-wizard.md` and
`web/components/google-setup-pane.tsx` first, then change the steps. Pane defined with
`Pane.define({ id: "google-maps-setup", parent: accountsPane, path: "google-maps/setup" })`,
built from the `setup-steps` primitive (`Steps` / `Step` / `StepLink` / `StepCommand` / `StepDone`).

A project-id field at the top (reusing google's `extractProjectId`, which accepts any
pasted console URL) parameterizes every deep link below it:

1. **Select or create a project** — `console.cloud.google.com/projectcreate`
2. **Enable the Places API** — `.../apis/library/places.googleapis.com?project=<id>`
3. **Link a billing account** — `.../billing/linkedaccount?project=<id>`. Google allows no
   API or CLI path to create a billing account; this step is human by design, and the copy
   should say so plainly rather than implying it can be skipped.
4. **Create an API key** — `.../apis/credentials?project=<id>`, with a note to restrict it
   to the Places API.
5. **Paste the key** — an input + Save calling `fetchEndpoint(setApiKey, { provider:
   GOOGLE_MAPS_PROVIDER_ID }, { body: { apiKey } })`. Central's `verify` runs the live
   probe here, so a wrong, unrestricted, unbilled or API-disabled key fails **in the
   wizard**, with Google's reason shown inline. No separate Test button is needed.
6. **Done** — reads `useAccountStatus(GOOGLE_MAPS_PROVIDER_ID).connected`.

`/api/auth/*` is already in the gateway's central-routes manifest, so `setApiKey` needs no
gateway change.

---

## 2. `plugins/integrations/plugins/google-maps/` — the broker

Mirrors `plugins/integrations/plugins/gmail/`.

- `core/` — the neutral wire types the block will store: `PlaceSuggestion { placeId,
  primary, secondary }` and `PlaceSnapshot { placeId, name, address, category?, mapsUrl?,
  lat?, lng? }`.
- `server/` — `getMapsKey(): Promise<MapsKeyResult>` wrapping
  `getTokenFromCentral({ providerId: GOOGLE_MAPS_PROVIDER_ID })` (no `scopes` — they are
  silently ignored for api-key accounts). Returns a discriminated
  `{ ok: true, key } | { ok: false, reason: "not-configured" }`; lets
  `AuthCentralOfflineError` propagate. Never returns `""`.
- `web/` — `useMapsAccess(): { ready, blocker: "not-configured" | null }` derived from
  `useAccountStatus`, and `MapsAccessAction`, a button that opens the setup wizard. Gmail's
  rule applies: a surface that cannot work renders the action that fixes it, instead of
  telling the user to go find Settings.

### 2b. `plugins/integrations/plugins/google-maps/plugins/places-api/`

Stateless typed client, server runtime only, key passed per call — the shape of
`plugins/apps/plugins/mail/plugins/gmail-api`. Two calls, both plain `fetch` against a
fixed Google host (`safe-fetch` guards *user-supplied* URLs; this URL is ours):

- `autocomplete(key, input, sessionToken)` → `POST https://places.googleapis.com/v1/places:autocomplete`,
  header `X-Goog-Api-Key`, body `{ input, sessionToken }` → maps `suggestions[].placePrediction`
  (`placeId`, `structuredFormat.mainText.text`, `secondaryText.text`) to `PlaceSuggestion[]`.
- `placeDetails(key, placeId, sessionToken)` → `GET https://places.googleapis.com/v1/places/{placeId}`
  with `X-Goog-FieldMask` (**required** — omitting it is an error) → `PlaceSnapshot`.

**The field mask is a cost decision, so it is one exported constant with a comment.** v1
requests only Essentials and Pro tier fields — `formattedAddress`, `location` (Essentials),
`displayName`, `googleMapsUri`, `primaryTypeDisplayName` (Pro). It deliberately omits
`rating`, `userRatingCount`, `regularOpeningHours`, `internationalPhoneNumber` and
`editorialSummary`, which are Enterprise-tier and roughly double the per-call price.
Adding a rating to the card later is a one-line mask change with a known bill attached.

Session tokens: one per search-to-selection round, passed to both calls, so Google bills
the pair as a single autocomplete session. At the time of writing the per-session
autocomplete SKU is free/unlimited and Place Details Pro runs ~$17/1,000 with a monthly
free allowance, but Google has re-cut this pricing more than once — re-check before
relying on the numbers.

---

## 3. `plugins/page/plugins/place/` — the block and the registry

### The registry

Server and web halves are two independent one-way registries joined by a shared id
string — the repo's established shape (`defineEventSourceType`, `defineWallpaperProvider`).
There is no server-side slot primitive and no cross-runtime bridge; do not invent one.

**Server** (`place/server`) — a module-scope `Map` plus a `Registration` token, the
single-method shape of `defineWallpaperProvider` (a place lookup has no polling or
fingerprint concern, so events' `probe`/`extract` split buys nothing here):

```ts
interface PlaceProvider {
  id: string;
  search(query: string, session: string): Promise<PlaceSuggestion[]>;
  resolve(placeId: string, session: string): Promise<PlaceSnapshot>;
}
definePlaceProvider(p: PlaceProvider): PlaceProvider & Registration
```

**Web** (`place/web`) — `Place.Provider` slot:

```ts
defineSlot<{
  id: string;
  label: string;
  icon?: IconType;
  /** Rendered in place of the search box when the provider is not usable yet. */
  AccessAction?: ComponentType;
  /** Reactive readiness, e.g. "is a key configured". Mirrors AuthScopeRequirement.useEnabled. */
  useReady?: () => boolean;
  /** Attribution line the provider's terms require on the card. */
  attribution?: string;
}>("page.place-provider")
```

`AccessAction` + `useReady` are what keep the block provider-blind: it renders "this
provider is not set up yet" without knowing that Google exists or that the blocker is a
key. With exactly one provider registered the block uses it silently; a picker is only
needed when a second one lands.

### Endpoints (`place/core`, implemented in `place/server`)

Both dispatch by `providerId` through the registry and are provider-agnostic:

- `GET /api/place/search?providerId=&q=&session=` → `{ suggestions: PlaceSuggestion[] }`
- `GET /api/place/resolve?providerId=&placeId=&session=` → `PlaceSnapshot`

An unknown `providerId`, or a provider whose credential is missing, throws — loudly, with
the reason. No empty-array fallback: an empty suggestion list must only ever mean "Google
found nothing".

### The block (`place/core` + `place/web`)

```ts
export const placeBlock = defineBlock({
  type: "place",
  schema: z.object({
    providerId: z.string().optional(),
    placeId: z.string().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    category: z.string().optional(),
    mapsUrl: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    fetchedAt: z.number().optional(),   // ms epoch; drives the 30-day refresh
  }),
  label: "Place",
  icon: MdPlace,
  aliases: ["address", "location", "map", "maps"],
  empty: () => ({}),
  gutterFirstLineCenter: "…",           // as image / sub-page do
  markdown: { tag: { name: "place", body: "none", attrs, parseAttrs } },
});
```

No `text` field, so `acceptsText` is `false` by derivation (`define-block.ts:359`) — the
editor's Backspace-merge and Delete-mergeNext ladders skip the row automatically
(`keystroke-intent.ts:528,568`). Do not set `semantics` (type-forbidden for a non-text
schema), `splitInto`, `breakOutOnEmptyEnter` or `defaultText`.

`markdown.tag` follows `page-link`'s pattern so `read_page` shows agents
`<place name="Café Kitsuné" address="51 Galerie de Montpensier, Paris" maps="https://…"/>`
rather than the derived JSON-attribute fallback.

**Three render states**, `plugins/page/plugins/bookmark/web/components/bookmark-block.tsx`
as the template:

1. **No `placeId`** — a search input. Debounced (~200ms; note that `quick-find` keeps a
   private `useDebouncedValue` copy — a third copy is not worth extracting yet, but say so
   in a comment), results as a keyboard-navigable list of `primary` / `secondary` lines.
   Selecting one writes `{ providerId, placeId }` and nothing else. When
   `useReady?.() === false`, render the provider's `AccessAction` instead of the input.
2. **`placeId` but no `name`, or `fetchedAt` older than 30 days** — resolving card. Fires
   `resolve` once per placeId (a `startedRef` guard, as bookmark does against StrictMode
   double-mount), then writes the snapshot plus `fetchedAt: Date.now()`. A stale snapshot
   keeps rendering its old content while the refresh runs — never blank.
3. **Resolved** — the card: name, address, category, an "Open in Google Maps" link
   (`mapsUrl`), the provider's `attribution` line ("Powered by Google" — required when
   Places content is not displayed on a Google map), and a hover-revealed replace button
   (`editor.update({})`, as bookmark's does).

Focus follows bookmark exactly: **no `registerFocusHandle`**, just `onFocus={() =>
editor.onFocus()}` on the input. The block is reached by click or Tab, and arrow-key
traversal skips it — the proven path for a search-driven card.

The session token is minted client-side per search round (`crypto.randomUUID()`), passed
to both endpoints, and dropped after resolve.

### `plugins/page/plugins/place/plugins/google/`

The whole point of the split: this plugin is thin.

- `server/index.ts` — `definePlaceProvider({ id: "google", search, resolve })`, where both
  methods read the key via `getMapsKey()` and delegate to `places-api`. ~40 lines.
- `web/index.ts` — one `Place.Provider({ id: "google", label: "Google Maps", icon,
  attribution: "Powered by Google", AccessAction: MapsAccessAction, useReady: () =>
  useMapsAccess().ready })` contribution. ~15 lines.

### Slash-menu registration

`/place` needs no menu code — the block menu ranks on `label` + `aliases`
(`block-type-list.tsx`). Add `"page.place:place"` to the **Media** group in
`config/page/editor/page.editor.block.jsonc`.

⚠️ That file is an override carrying a `// @hash` line. Adding a block regenerates the
origin with a new hash, and `config-origins-in-sync` fails until the override's `@hash` is
restamped. Run `./equin build`, then copy the new hash from the regenerated
`.origin.jsonc` into the override.

---

## Build order

1. `plugins/auth/plugins/google-maps/` (core + central + web) — the provider, with `verify`.
2. The generic api-key branch in `plugins/auth/web/components/default-provider-row.tsx`.
3. `plugins/auth/plugins/google-maps/plugins/setup-wizard/` — the pane. **Stop here and get
   a real key end-to-end before writing any block code**; everything downstream depends on
   it and this is the step with the untested machinery under it.
4. `plugins/integrations/plugins/google-maps/plugins/places-api/` — the client.
5. `plugins/integrations/plugins/google-maps/` — the broker (`getMapsKey`, `useMapsAccess`,
   `MapsAccessAction`).
6. `plugins/page/plugins/place/` — registry, endpoints, block, component.
7. `plugins/page/plugins/place/plugins/google/` — the adapter, plus the block-menu config entry.

## Verification

Deploy with `./equin build` (background, per the workflow rules), then at
`http://att-1787082815-a6eg.localhost:9000`:

**The credential**
- Settings → Accounts shows a **Google Maps Platform** row reading "Not set up", with an
  **Add key** button. Confirm it opens the wizard and does *not* open an OAuth popup —
  this is the regression the generic fix exists to prevent.
- Paste a malformed key → rejected by `pattern`, no network call. Paste a well-formed but
  wrong/unbilled key → rejected inline with Google's own message. Paste a good key → row
  reads Connected.
- Confirm the OAuth providers (Google, Notion) still render and connect unchanged.

**The block**
- In a page, type `/place` → the block appears in the Media group; `/address` and `/map`
  also find it.
- Type a partial address → suggestions appear after the debounce, not per keystroke
  (watch the network panel). Select one → card renders.
- Reload the page → the card renders instantly from the snapshot with no network call.
- `query_db` on `page_blocks` to confirm the stored `data` shape and `fetchedAt`.
- Temporarily disconnect the key → an empty `/place` block renders `MapsAccessAction`
  rather than a dead search box or a silent failure.
- `read_page` (MCP) on the page → the block serializes as `<place …/>`, and `edit_page`
  round-trips it without dropping the block.

**Automated**
- `./equin test plugins/page/plugins/place` — pure-function tests for the Google →
  `PlaceSnapshot` mapper and the 30-day staleness predicate.
- `bun plugins/page/plugins/place/e2e/place-block.ts` — a manual e2e driving
  `/place` → search → select → reload, built on the `e2e-harness` helpers.

## Risks

- **The api-key arm has never run in production.** No tests cover
  `actions.setApiKey`, the apikey branch of `token-access.ts`, or the apikey
  `credentialsConfigured` path. Budget time in step 3 for fixing something small in
  `plugins/auth/central`.
- **`verify` runs on the central runtime**, which must reach the internet. A failure there
  surfaces as a 400 in the wizard, which is the desired loud behaviour, but the error copy
  needs to distinguish "your key is wrong" from "central could not reach Google".
- **Google pricing and caching terms move.** The field mask, the 30-day refresh window and
  the attribution line are the three places where those terms are encoded; keep each of
  them a single named constant with a comment pointing at the policy it implements.
- **Deferred, deliberately**: the OSM provider (drops in behind the registry with no block
  change), the live embedded map (needs the second, public Embed key), and Enterprise-tier
  fields like ratings and opening hours.
