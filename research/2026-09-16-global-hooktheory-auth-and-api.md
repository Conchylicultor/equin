# Hooktheory (TheoryTab) — sign-in and API access

## Context

First step of a chord-recognition trainer (page `block-acef974d…`, "Chords training"):
listen to a song, pick its chord progression, progressively unlock more chords
(I IV V → …). The songs come from Hooktheory's TheoryTab database. This step
gives the app **authenticated access to that database** and nothing else — no
trainer UI yet.

What Hooktheory actually exposes (probed live, 2026-09-15):

| Call | Auth | What it returns |
|---|---|---|
| `POST https://api.hooktheory.com/v1/users/auth` (form body `username`, `password`) | — | `{ id, username, activkey }`. 401 JSON `{name,message,status}` on bad creds (e.g. "There are no accounts with this username."). |
| `GET /v1/trends/nodes?cp=1,4` | `Authorization: Bearer <activkey>` | Next-chord probabilities after a progression: `[{chord_ID, chord_HTML, probability, child_path}]`. |
| `GET /v1/trends/songs?cp=1,5,6,4&page=N` | Bearer | Songs containing a progression, paged: `[{artist, song, section, url}]` (shape from docs; confirm after sign-in). |
| `GET /v1/songs/public/<hash>?fields=ID,song,jsonData` | **none** | One TheoryTab section. `jsonData` is a JSON **string** (Hookpad 2.x doc): `chords[]` (scale-degree `root`, `beat`, `duration`, `type`, `inversion`, `applied`, `borrowed`, `isRest`, …), `notes[]`, `keys[]` (`tonic`, `scale`), `meters[]`, `tempos[]` (`bpm`), `endBeat`, and `youtube: { id, syncStart, syncEnd }` — exactly the data the trainer needs (YouTube loop + chord timing). 400 on an unknown hash. |

The `<hash>` (e.g. `_NgbRXeYgQA`) appears in the TheoryTab page HTML, one per
section; `trends/songs` gives a page URL, not the hash. Mapping one to the other
is **out of scope** here (see Follow-ups) — we'll decide once we see a real
`trends/songs` response.

Auth is a username/password → long-lived token exchange. The repo's auth
plugin knows two kinds, `oauth2` and `apikey`; neither fits (apikey would make
the user fish the activkey out with curl). So we add a third, generic kind.

## Design

### 1. Auth plugin: a `password` provider kind (generic, load-bearing)

A provider of kind `password` declares how to trade a username + password for a
long-lived token. The user types them once in Settings → Accounts; central
calls the provider's `exchange`, **stores only the returned token** (as the
existing static-credential field), and drops the password. From then on the
account behaves exactly like an api-key account: `getAccessToken` /
`getTokenFromCentral` hand the token back with `expiresAt: MAX_SAFE_INTEGER`.

Files (`plugins/auth/`):

- `core/internal/lib.ts`
  - `export const AUTH_PROVIDER_KINDS = ["oauth2", "apikey", "password"] as const;`
    `AuthProviderKind` derived from it.
  - `PasswordConfig { usernameLabel?: string; help?: string; signUpUrl?: string; exchange(creds: { username; password }): Promise<{ token: string; identity: AuthIdentity }> }`
  - `AuthProviderDescriptor.password?: PasswordConfig`; `defineAuthProvider`
    asserts `kind: "password"` ⇒ `.password` (same as the two existing branches).
- `core/resources.ts` — `kind: z.enum(AUTH_PROVIDER_KINDS)`.
- `central/internal/auth-resource.ts` — today it **re-declares** the whole state
  schema (the `kind` enum included); import `AuthStateValueSchema` from core
  instead, so a fourth kind can't drift between the two copies.
- `core/endpoints.ts` — `signIn = defineEndpoint({ route: "POST /api/auth/sign-in/:provider", body: { username, password }, response: { ok: true, identity } })`.
  The build's central-routes scanner picks the new `/api/auth/sign-in/` prefix up
  automatically; no gateway change.
- `central/internal/actions.ts` — `signInWithPassword(providerId, username, password)`:
  rejects a non-`password` provider, calls `descriptor.password.exchange`, then
  `setAccount(…, { kind: "password", apiKey: token, identity, connectedAt })`,
  `invalidateAuthStateCache()`, `notifyAuthState()` — mirrors `setApiKey`.
- `central/internal/handlers/sign-in.ts` — `implement(signIn, …)`; any failure →
  `HttpError(400, provider's own message)`, like `handlers/api-key.ts`. Registered
  in `central/index.ts` `httpRoutes`.
- `central/internal/token-access.ts` — the static-credential branch becomes
  `account.kind === "apikey" || account.kind === "password"`.
  (`auth-state.ts` already treats every non-oauth2 kind as
  `credentialsConfigured: true`; refresh loop only walks oauth2 — both correct as-is.)
- `web/components/default-provider-row.tsx` — today the buttons and the status
  pill are boolean ternaries on `isApiKey`, with OAuth as the catch-all else. A
  new kind added there would fall into the OAuth branch and open a popup that
  central rejects with a 400. Restructure both into an exhaustive
  `switch (kind)` (TS `never` default) so the next kind is a type error, not a
  silent OAuth popup. `password` arm: **Sign in** (not connected) / **Sign in
  again** + **Disconnect** (connected); pill Connected / Not signed in. The
  identity line shows `identity.email ?? identity.displayName` (the Hooktheory
  username; today it reads `email` only).
- `web/components/password-sign-in-dialog.tsx` (new, generic) — opened with
  `openDialog` (`primitives/overlay/imperative-dialog`). Two labelled `Input`s
  (`Text as="label" variant="label"` pairing from the google-maps setup pane),
  password field `type="password"`, Enter submits, inline error via
  `getEndpointErrorMessage`, a "Create an account" link when `signUpUrl` is set.
  Shape copied from `theme-gallery/web/components/rename-theme-dialog.tsx`.
  Needs the provider's labels on the web side → `AuthProviderContribution`
  gains optional `passwordSignIn?: { usernameLabel?; signUpUrl? }` (presentational,
  like `helpUrl`).
- `CLAUDE.md` — document the third kind next to OAuth / API keys.

Why the password isn't stored: the activkey is long-lived, so storing it is
enough, and a stored password is a strictly worse secret to hold. Cost: if
Hooktheory ever revokes the key, the user signs in again (the consumer surfaces
that — see §3). Same known limit api-key accounts already document.

The password crosses browser → gateway → central once, in a request body on
localhost; it is never persisted or logged.

### 2. Hooktheory provider — `plugins/auth/plugins/hooktheory/`

Modelled on `auth/plugins/google-maps` (central + core), plus a web barrel for
the Accounts row (notion-style; no setup pane needed).

- `core/index.ts` — `HOOKTHEORY_PROVIDER_ID = "hooktheory"`,
  `HOOKTHEORY_API_BASE = "https://api.hooktheory.com/v1"` (named once; the
  integration reads both).
- `central/internal/descriptor.ts` — `defineAuthProvider({ id, name: "Hooktheory", kind: "password", password: { usernameLabel: "Username", signUpUrl, exchange } })`.
  `exchange` POSTs the form body to `/users/auth`; non-2xx → throws with
  Hooktheory's own `message` (tolerant parse, raw text fallback — the
  google-maps `googleErrorText` pattern); network failure → "Could not reach
  Hooktheory…". Success body zod-parsed; identity =
  `{ accountId: "primary", displayName: username }`.
- `central/internal/register.ts`, `central/index.ts` — as google-maps.
- `web/index.ts` — `Auth.Provider({ id, name: "Hooktheory", icon, helpUrl, passwordSignIn: { signUpUrl } })`.
  Icon: no Hooktheory glyph in `react-icons/si`; use `MdMusicNote` from
  `react-icons/md` (named import — `icon-safety` bans namespace imports).
- No `server/` barrel: like google-maps, there are no config fields to register.

### 3. API client — `plugins/integrations/plugins/hooktheory/`

The integration owns the Hooktheory vocabulary so the future trainer never
imports `@plugins/auth` (the `integrations/google-maps` broker pattern).

- `core/` — zod schemas + inferred types: `TrendNode`, `TrendSong`,
  `TheorytabSection` (a typed subset of `jsonData`: chords, notes, keys, meters,
  tempos, endBeat, youtube; zod strips the editor-only fields). Endpoint
  contracts (below). Errors: `HooktheoryApiError(status, message)`,
  `HooktheoryNotSignedInError`.
- `server/internal/request.ts` — `hooktheoryFetch(path, { auth })`: plain
  `fetch` (fixed host — same rationale comment as
  `places-api/server/internal/request.ts`), Bearer from
  `getTokenFromCentral({ providerId })` when `auth`; `needsConsent` →
  `HooktheoryNotSignedInError`; non-2xx → `HooktheoryApiError` with
  Hooktheory's message (a 401 says "sign in again in Settings → Accounts");
  success body parsed with the caller's schema. This deliberately departs
  from places-api / gmail-api (plain interfaces + `as T` cast): the section
  payload is a free-form editor document from an undocumented endpoint, so a
  shape change must fail at the boundary with the field named, not deep in
  the trainer.
- `server/internal/client.ts` — `getTrendNodes(progression: number[])`,
  `getTrendSongs(progression, page)`, `getTheorytabSection(id)` (public, no
  token; parses the `jsonData` string then the schema).
- Endpoints (worktree server, `httpRoutes`), thin wrappers so the browser (and
  curl) can reach them; `HooktheoryNotSignedInError` → 409 with a sign-in
  message, `HooktheoryApiError` → 502 carrying Hooktheory's text:
  - `GET /api/hooktheory/trends/nodes?cp=1,4`
  - `GET /api/hooktheory/trends/songs?cp=1,5,6,4&page=1`
  - `GET /api/hooktheory/sections/:id`
- `web/` — omitted until the trainer needs hooks.

No caching, no rate limiting, no retry in this step: nothing calls it in a
loop yet, and a visible failure beats a silent backoff while we learn the API.

## Verification

1. `./equin build` (background) — boundaries, type-check, plugin docs,
   central-routes manifest regenerate.
2. `./equin test plugins/integrations/plugins/hooktheory` — schema tests
   (`server/internal/*.test.ts`) against the real `Let It Be` section captured
   during this design (`_NgbRXeYgQA`), kept verbatim as a `fixtures.ts` module
   (the `events/sources/coworkmeet` convention), plus an error-envelope parse.
   A `defineAuthProvider` test for the new `password` branch in auth.
3. Unauthenticated path works now: `curl http://<wt>.localhost:9000/api/hooktheory/sections/_NgbRXeYgQA`
   → parsed chords + `youtube.id`. `…/trends/songs?cp=1,5` → 409 "sign in".
4. **You**: Settings → Accounts → Hooktheory → Sign in. Wrong password shows
   Hooktheory's message inline; right one flips the row to Connected with your
   username, in every worktree.
5. Re-run `trends/nodes` / `trends/songs` → real data; record the actual
   `trends/songs` shape in the integration's CLAUDE.md and tighten its schema.
6. Screenshot the Accounts row + sign-in dialog (`e2e-harness/screenshot.ts`).

## Follow-ups (not this step)

- **Song selection needs our own index, not `trends/songs`.** `trends/songs`
  matches one exact contiguous sequence (`1,4,5` ≠ `5,1,4`), but the trainer's
  query is "sections whose chords are all within the unlocked set (and use the
  new chord)". Index each section's chord vocabulary in Postgres (array column,
  GIN, `<@` / `&&`) and query that. Seed it from the Sheet Sage
  `Hooktheory.json.gz` dump (26,175 sections, keyed by the same Hooktheory id
  `songs/public/<id>` accepts — verified; YouTube id + beat→time alignment +
  chords per section; CC BY-NC-SA 3.0, fine for personal use). Checked on the
  dump: 883 major, single-key sections use only I / IV / V triads, in any
  order. Top up newer songs by walking `trends/nodes` over the unlocked chords
  and feeding `trends/songs` hits through `sections/:id`.

- TheoryTab page URL → section hashes (needed to go from `trends/songs` to
  `sections/:id`); decide scrape vs. another endpoint once step 5 shows what
  `trends/songs` returns.
- The chord trainer itself — likely a Sonata sub-plugin next to `rich` /
  `theory` / `voicing`; plan separately.
- A consumer-observed 401 could mark the account `needsReconsent` centrally
  (today it only errors at the call site, like api-key accounts).
