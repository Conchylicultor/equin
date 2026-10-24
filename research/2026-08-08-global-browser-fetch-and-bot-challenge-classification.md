# Browser-backed page fetch, and making a bot challenge terminal

## Context

The Events source `https://shotgun.live/en/venues/paris-erasmus-life` fails every
refresh. The run ledger shows six identical failures reading
`unknown: Page returned 429 fetching …`.

It is **not** rate limiting. Verified empirically:

- Every plain HTTP request to *any* page on that site returns `429` with
  `x-vercel-mitigated: challenge` and a "Vercel Security Checkpoint" body, on the
  first request, in ~200 ms. Even `https://shotgun.live/` does. Only
  `robots.txt` (which is `Allow: /`) passes.
- It is not header-fixable: a full Chrome header set (UA, `sec-ch-ua`,
  `sec-fetch-*`, `accept-language`, `upgrade-insecure-requests`) still gets 429.
  The mitigation keys on the TLS/client fingerprint, which Bun's `fetch` cannot
  disguise.
- Headless Chromium gets **200 immediately** — no JS puzzle is being solved, the
  fingerprint alone is the gate. The page is server-rendered and carries 11
  `<time datetime="…">` elements, i.e. exact instants, which is ideal extractor
  input.
- There is no JSON API behind the page to call instead (network trace is empty of
  JSON/XHR).

So this is a generic bot-mitigation false positive on a page the site's own
`robots.txt` explicitly permits crawling — and the only client that can read it
is a real browser.

There is a second, independent case for the same capability: **client-rendered
pages**. `desmotsetdesarts.com` returns 200 to a plain fetch but its events exist
only after JS runs (browser render: 66 KB with real event content). It currently
has 0 live events for that reason.

And there is a case a browser does **not** fix, which the design must fail
informatively for rather than pretend to handle: `thursday.com` is behind a
cookie-consent wall and renders empty even in a real browser.

Alongside the capability there is a genuine defect on our side: a challenge `429`
is classified **transient**, so the 15-minute tick retries it forever, writing a
`failed` run row each time and surfacing a message the user cannot act on.

**Outcome intended:** Shotgun works on the next tick with no per-source tuning;
JS-rendered sites work by setting one field; and a page nothing can read parks
the source once with a sentence explaining why.

---

## Measured costs (verified, not estimated)

| Operation | Cost |
|---|---|
| `chromium.launch()` | ~4.0 s (one-time per call — see lifecycle) |
| `page.goto` + `page.content()` | ~0.6–1.2 s |
| `browser.close()` | ~0.2 s |
| Shotgun page HTML | ~340 KB |

---

## Part 1 — the `browser-fetch` primitive

**Location:** `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/`
(`@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/{core,server}`).

Nested under `safe-fetch` because these are two implementations of one idea —
read a public URL without ever reaching a private address — and the child must
import the parent's four SSRF primitives. Precedent for a plugin having both its
own runtime code and sub-plugins: `infra/duress` + `infra/duress/plugins/latch`.

### Public API — one function

```ts
// server/index.ts
export { browserFetch } from "./internal/browser-fetch";
export { BrowserFetchError } from "./internal/errors";
export type { BrowserFetchInit, BrowserFetchResult, BrowserFetchFailureKind } from "./internal/types";

export function browserFetch(
  target: string | URL,
  init?: BrowserFetchInit,
): Promise<BrowserFetchResult>;

interface BrowserFetchResult {
  url: string;                              // final URL after redirects
  status: number;                           // final main-document status
  headers: Record<string, string>;          // lowercased — lets the caller re-run detectBotMitigation
  html: string;                             // serialized DOM after render. NEVER truncated.
  redirects: number;
  timings: { launchMs: number; navigateMs: number; settleMs: number; totalMs: number };
}
```

`BrowserFetchInit` carries `timeoutMs` (45 s, whole-op, clock starts *after* pool
admission), `navigationTimeoutMs` (20 s), `launchTimeoutMs` (30 s), `settleMs`
(3 s), `waitForSelector?`, `maxRedirects` (3), `maxHtmlBytes` (8 MiB),
`maxNetworkBytes` (24 MiB), `viewport` (1280×2400, tall so lazy lists render more
rows), `signal?`.

**Throw, not a discriminated result** — per the `api-design` rule. `status` is a
field on the *success* value (a 404 still renders HTML; the caller decides what
404 means, exactly as `safeFetch` callers own `assertFetched`). Everything that
prevented reading the page at all throws:

```ts
type BrowserFetchFailureKind =
  | "browser-unavailable" | "navigation-failed" | "navigation-timeout"
  | "selector-timeout" | "too-many-redirects" | "html-too-large"
  | "network-budget-exceeded" | "aborted";

class BrowserFetchError extends Error { readonly kind; readonly url; /* name = "BrowserFetchError" */ }
```

Two deliberate choices:

- **`SsrfError` propagates unwrapped.** `classify-error.ts` matches
  `name === "SsrfError"` → `blocked_url`, terminal. Reusing the existing type
  means the browser path classifies identically to the plain path with no edit
  there. Wrapping it would silently downgrade a terminal SSRF refusal to a
  transient unknown.
- **`browser-unavailable` deliberately lands in the transient bucket.** A missing
  Chromium is an operator problem, not the user's URL being wrong; parking the
  source with a red error would be a lie.

### Lifecycle: launch-per-call, closed in `finally`

This is settled by a security fact, not by taste: **`--host-resolver-rules` is a
Chromium *launch* flag**, and it is the only mechanism inside Chromium that pins
DNS. A warm/reused browser therefore has exactly three options for a second host
— resolve it with Chromium's own unguarded resolver (throwing away the
DNS-rebinding protection `safe-fetch` exists to provide), relaunch anyway (which
*is* launch-per-call), or build an in-process forward proxy (hundreds of lines of
TLS tunnelling and a second copy of the pinning logic that can drift).

The secondary arguments agree: there is no precedent for a supervised long-lived
child process inside a Bun `server/` process — the one comparable case
(`zero-cache`) deliberately pushed supervision out to the Go gateway — and a warm
browser would need crash detection, restart backoff, zombie reaping across
`./equin build` restarts and an idle timer, in up to ~16 worktree backends
at once (~4 GB of idle Chromium). Amortization is near zero anyway: refresh is a
15-minute cron with a per-source dedup key, so consecutive calls are minutes
apart.

**Accepted cost, stated plainly:** every call pays ~4.2 s of launch+close. A
single "Refresh now" takes ~5–6 s instead of ~1 s. That is fine for an explicit
action with a spinner, and it is the honest price of pinning.

### SSRF design

Pre-flight, before anything is spawned (and before pool admission — a refusal
must never queue behind a slot):

```ts
const logicalUrl = parsePublicUrl(target);          // sync: scheme + literal-host guard
const ip = await assertResolvesPublic(logicalUrl);  // all A/AAAA records; returns the validated IP
```

**Launch args** (`launch-args.ts`, pure, unit-tested):

```
--host-resolver-rules=MAP <host> <ip>,MAP * ~NOTFOUND
```

- `MAP <host> <ip>` pins the target. Verified: 200, with SNI and cert validation
  still correct against the real hostname.
- **`MAP * ~NOTFOUND` is the structural backstop and is not optional.** Without
  it, anything slipping past request interception (a cross-host redirect, a
  prefetch, a beacon) reaches Chromium's own resolver. With it, no hostname other
  than the pinned one resolves inside this browser process at all.
- Plus `--disable-background-networking`, `--no-first-run`, `--disable-sync`,
  `--disable-component-update`, `--js-flags=--max-old-space-size=512`.
- **Never `--no-sandbox`** (we execute hostile third-party JS; the sandbox is the
  containment) and **never `--ignore-certificate-errors`** / `ignoreHTTPSErrors`.
- Context: `serviceWorkers: "block"`, `acceptDownloads: false`, honest UA.
- Do **not** pass an explicit `executablePath` — use `chromium.launch()` and let
  provisioning own the revision.

**Request policy** (`request-policy.ts`, pure, unit-tested) via
`context.route("**/*")`, evaluated in this exact order:

1. `image` / `media` / `font` → **block**, purely for speed. Verified: blocking
   `res.cloudinary.com` still rendered the full 338 KB Shotgun page. Keep
   `stylesheet` (some frameworks gate first paint on it).
2. Non-`http(s)` scheme (`file:`, `chrome:`, `ws:`) → **block**. (`data:`/`blob:`
   pass; no network.)
3. **`parsePublicUrl` on every remaining request** → block on throw. **This is
   not redundant with the resolver rules and is the single most important line
   in the file:** a request to a bare IP literal
   (`http://169.254.169.254/latest/meta-data/`) performs no DNS lookup, so both
   `MAP` rules are inert against it. Trusting the resolver alone leaves a live
   cloud-metadata hole.
4. Navigation to a host ≠ the pinned host → **block** (handled by the redirect
   loop below).
5. Host === pinned host → **direct**. Must stay a real Chromium request — that
   real TLS fingerprint is the entire point.
6. Otherwise → **proxy**: fetch it with `safeFetch` in-process and answer with
   `route.fulfill()`. Chromium then makes no request and performs no lookup, so
   the subresource gets *all* of `safeFetch`'s guarantees. Blocking cross-origin
   outright instead would break the SPA case (Wix/SPA bundles live on third-party
   CDNs) — and it would break it *as a silently empty page*, which is the exact
   failure shape that makes the events engine delete events.

**Redirects to a new host** require a relaunch (the pin is a launch arg). Loop:
re-run `assertResolvesPublic` → relaunch pinned to the new host → navigate, up to
`maxRedirects: 3` (lower than `safeFetch`'s 8 because each hop costs ~4 s). Gives
per-hop revalidation and per-hop pinning, matching `safeFetch`. Same-host
redirects need no relaunch (`MAP` binds a hostname regardless of scheme/path).

**Residual gaps, stated honestly** (they belong verbatim in the plugin's
CLAUDE.md):

1. `context.route` does not cover WebSockets — use `page.routeWebSocket("**", ws => ws.close())`.
   WebRTC/QUIC to an IP literal is not interceptable at all. `MAP * ~NOTFOUND`
   still blocks anything hostname-based, so the surviving hole is a private IP
   literal over a non-routable channel.
2. **We execute attacker-controlled JS.** `safeFetch` returns bytes we parse;
   this runs a full JS engine on hostile input in our user account. A Chromium
   sandbox escape is a materially larger blast radius. Mitigated by: sandbox on,
   ephemeral profile, no downloads, no persistent storage, capped JS heap.
3. Chromium's DNS cache is per-launch, so there is no cross-call rebinding window
   — a bonus of launch-per-call that disappears the moment a warm browser is
   reintroduced.

### Host concurrency

Add to `RESERVED_POOLS` in `plugins/infra/plugins/host-admission/core/internal/budget.ts`:

```ts
"browser-fetch": { size: 2, cost: { cpu: 1, ramBytes: 400e6 } },
```

`cpu: 1` because launch+render genuinely saturates ~a core across browser +
renderer + GPU processes. `size: 2` as a **constant** (precedent: `db-fork`) —
`size` names the flock slot files and must be identical in every backend.
Budget impact: reserved 6.5 → 8.5, so `B` goes 11 → 9; `host-budget` still
passes. That cost is correct: the browser competes honestly instead of hiding.

`server/internal/pool.ts` mirrors `host-read-pool`'s two-tier shape
(`plugins/infra/plugins/host-read-pool/server/internal/pool.ts`), with a
**per-worktree local gate of 1**: main's cadence can enqueue N source jobs at
once, and without it main would present N waiters and starve a worktree's single
interactive "Refresh now". No reentrancy guard (a `browserFetch` never nests in a
`browserFetch`) — say so in a comment so nobody copies the `AsyncLocalStorage`
block from `withHeavyReadSlot`. The slot is held across launch → render → close;
validation happens outside it.

Do **not** reuse the `heavy-read` pool — it is sized `cpus/4` for git/fs reads and
sits on the interactive live-state loader path.

Skip `spawn-priority` demotion in v1: the only way to apply it is
`executablePath: taskpolicy, args: ["-b", "--", realExe, …]`, a fragile coupling
to Playwright's internal argv construction, and `darwinbg` pins to E-cores,
roughly doubling a user-visible "Refresh now". The size-2 pool is the real
protection.

### Dependency and provisioning

- Add `"playwright": "^1.60.0"` to the new plugin's `package.json`
  `dependencies`. A `server/` runtime importing a root **dev**Dependency is a lie
  about what the backend needs to run. Keep the root devDependency too (the
  `e2e/` scripts need it as tooling); same caret range hoists to one copy.
- Move the provisioning body into the new plugin's `core/` as
  `ensureChromium()` (Node-only core, precedent: `infra/file-sink`), contribute
  `provision/index.ts` calling it, and change
  `plugins/framework/plugins/tooling/plugins/e2e-harness/provision/index.ts` to
  call the same function. The backend's runtime correctness must not silently
  depend on a tooling plugin's install step. The runner is idempotent, so the
  second contribution is one `existsSync` in steady state.

### Bounds

| Bound | Value | On breach |
|---|---|---|
| Launch / Chromium missing | 30 s | `browser-unavailable` (message includes `bunx playwright install chromium`) |
| Navigation | 20 s | `navigation-timeout` / `navigation-failed` |
| Settle (`networkidle`) | 3 s | **not a failure** — the ceiling is the expected path |
| `waitForSelector` (if given) | `settleMs` | `selector-timeout` |
| Network bytes | 24 MiB | `network-budget-exceeded` |
| Serialized DOM | 8 MiB | `html-too-large` — **never a truncated page** |
| Redirects | 3 | `too-many-redirects` |
| Whole op | 45 s | `aborted` |

The settle timeout is the one legitimate `catch`, written in the sanctioned
shape (`.catch(err => { if (!(err instanceof errors.TimeoutError)) throw err; })`),
never a bare swallow. `finally` closes the browser on every path.

---

## Part 2 — the Events integration

### The fetch-mode field

`plugins/apps/plugins/events/plugins/sources/plugins/url-extract/core/internal/config.ts`:

```ts
export const URL_FETCH_MODES = ["auto", "plain", "browser"] as const;
export type UrlFetchMode = (typeof URL_FETCH_MODES)[number];

fetchMode: enumField({
  label: "Fetch mode",
  description:
    "Auto fetches the HTML directly and only starts a browser when the site answers with a bot " +
    "challenge. Browser render always loads the page with JavaScript — slower, and the right " +
    "choice when the page looks fine in your own browser but the extractor finds no events.",
  options: [
    { value: "auto", label: "Auto" },
    { value: "plain", label: "Plain fetch" },
    { value: "browser", label: "Browser render" },
  ],
  default: "auto",
  display: "radio",
}),
```

Placed between `url` and `hint` (field order is render order; it is a property of
*how the URL is read*, and `hint` is a later, model-facing concern).

`enumField`, **not** `enumTextField` — the latter's `type` is `textFieldType`, so
`FieldRenderer` would dispatch to a free-text input.

**Zero web edits and zero migration**, confirmed in code: `SourceConfigForm` maps
`Object.entries(fields)` through `FieldRenderer`, which dispatches on
`field.type.id`; `fieldsToZodObject` wraps every field with
`.default(field.defaultValue)` on a non-strict object, so the six existing rows
with no `fetchMode` key parse to `"auto"` on both runtimes. Narrow `string` → the
union once, in `source-config.ts`, with a guard that throws (never a `?? "auto"`
cast — that is precisely the absorbable failure the rules forbid).

**Decision: `auto` escalates only on a *failing* response that carries
bot-mitigation evidence — never on a thin 200.** (I had intended to put this to
you as a question; you interrupted it, so I am taking the conservative reading
and flagging it here for you to overrule.) Three reasons, in severity order:

1. A thin-200 rule can only be a content threshold, and this file's history is a
   scar from exactly that: `MAX_HTML_BYTES`' comment records how a byte offset
   silently turned fitzroy-paris.com into a title-only page. "Fewer than N chars
   ⇒ SPA" trips on a venue that is genuinely between seasons.
2. **It makes the fingerprint bistable, which costs money forever.**
   Failure-escalation is safe precisely because the plain path *throws* and
   produces no fingerprint. With a 200-escalation the same URL yields plain text
   or browser text depending on which side of the threshold a tick landed — the
   fingerprint flips, `runSource` sees "changed", and pays for a Sonnet
   extraction every 15 minutes, defeating the probe/extract split.
3. It can go backwards: if the browser is slow or unavailable and the heuristic
   falls back, the model gets a *shorter* page — which is how the engine is told
   the listing emptied.

What replaces the magic: the field description names the symptom in the user's
words, and `assertReadable` (below) turns the fully client-rendered case into a
terminal error whose message says to set Browser render. Zero readable text is a
fact; N characters is a guess.

### Mitigation detection

A pure `detectBotMitigation(status, headers): BotMitigation | null` in the
primitive's `core/` — the predicate means "a browser is the one thing that would
change this answer", which is the primitive's own domain knowledge, not
url-extract's HTTP policy.

```ts
const MITIGATION_HEADERS = ["x-vercel-mitigated", "cf-mitigated"] as const;
const NAMED_STATUSES = new Set([403, 429, 503]);   // named-header branch
const SHAPE_STATUSES = new Set([403, 429]);        // cloudflare-shape branch
```

Returns `{ signal }` — the header we literally saw, quoted into the user-facing
message, never a vendor we inferred.

Honesty guardrails, all load-bearing:

- Only `x-vercel-mitigated` is **verified** (shotgun.live). `cf-mitigated` is
  vendor-documented but unobserved here. The `server: cloudflare` + `cf-ray`
  branch is labelled inference; it is **not** extended to 503, because a
  Cloudflare 503 is just as likely an origin outage, and calling that terminal
  would park a healthy source through it.
- **No** Akamai / DataDome / PerimeterX entries — a guessed header that never
  fires is dead code that reads like coverage.
- **No body sniffing** ("Just a moment…") — impure, locale-dependent, and it
  forces reading a body we currently cancel.
- **Never fires on a 2xx** — a readable page carrying the header is still
  readable.
- **A bare 429 with no header is not mitigation.** That is the real rate-limit
  case and it must keep retrying.

### The restructured `probeUrlPage` — one branch, one pipeline

`plugins/apps/plugins/events/plugins/sources/plugins/url-extract/server/internal/probe.ts`.

The leverage is in *where* the branch sits: a small `fetchPage()` returns a
transport-blind value, so every bound, both renderings and the fingerprint run
through exactly one path. "We started a browser" can then never change what a
page *means*, only how its bytes were obtained.

```ts
interface FetchedPage {
  url: string;
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  via: "plain" | "browser";   // for message copy, never for control flow
  truncated: boolean;
}

probeUrlPage = (ctx) => readPage(await fetchPage(target, config.fetchMode), target);
```

Bytes + content-type rather than a string, deliberately: the charset lives on the
content-type, where both readers already look. Converging on a string would mean
re-implementing charset sniffing for the plain path and mojibake-ing every
windows-1252 page. The browser path has already decoded, so it re-encodes to
UTF-8 and says so.

`fetchPage` — the only branch:

- `mode === "browser"` → `renderPage`.
- otherwise `safeFetch`, then **read the mitigation signal before the status
  rule** (both of that rule's readings are wrong here: 4xx would park the source
  saying the URL is bad, 429 would retry a challenge that will not change its
  mind). On mitigation: cancel the body, then `plain` → throw
  `BotChallengeError.inPlainMode`, `auto` → `renderPage`.
- otherwise `assertStatus`, `readCappedBody`, return.

`renderPage` calls `assertResolvesPublic(target)` first as defence in depth (the
browser does its own DNS and redirects, so `safeFetch`'s pinned dial protects
nothing here), then `browserFetch`. If the rendered status is 403/429 → throw
`BotChallengeError.afterRender` (a real browser with real JS was refused; there
is nothing left to escalate to, so this is where the retry loop stops).

`readPage` — network-free, transport-blind, and therefore **unit-testable without
a fetch**, which is the half that decides whether a page is safe to hand the
model. It runs, in order: `assertWhole(truncated)` → `extractVisibleText` →
`assertWhole(text)` → **`assertReadable`** → `simplifyPageHtml` →
`assertWhole(markup)` → fingerprint.

Answers to the mechanical questions:

- `extractVisibleText` is fed a synthesized `Response` on **both** paths — as it
  already is today (`probe.ts` builds one from in-memory bytes; nothing has
  streamed from the socket since `readCappedBody`). No signature change to
  `page-text.ts`.
- `MAX_HTML_BYTES` on the browser path is a post-hoc `byteLength` check surfaced
  through the same `truncated` flag, so the assertion and its message stay in one
  place. It is honestly weaker than the plain path's cancel-the-reader bound, and
  the comment must say so; the real ceiling on that path belongs to the
  primitive's `maxHtmlBytes`.
- `MAX_TEXT_CHARS` / `MAX_MODEL_HTML_CHARS` are unchanged and shared — they were
  always applied to a decoded page.
- `assertFetched` → `assertStatus(status, url)`, taking a status so both
  transports are judged by the same rule. Semantics unchanged.

**New guard `assertReadable`** — a page with no readable text at all is a
failure, for the same reason a truncated one is: downstream it is
indistinguishable from a venue with nothing on, and the model's truthful
`{"events": []}` makes `runSource` stamp `disappearedAt` on every event the
source ever found. `parse-response.ts` cannot catch it (an empty result is a
documented legitimate success there). The test is `=== 0` characters — a fact,
not a threshold — and it only ever throws, so it strengthens the never-a-shorter-
page invariant rather than trading against it. The remedy sentence differs by
`via`: plain → "set Fetch mode to Browser render"; browser → "a browser rendered
it and it is still empty — it is behind a cookie or sign-in wall this extractor
cannot clear" (this is the `thursday.com` outcome). Note in review that this also
fixes an **existing** latent bug: today an empty plain fetch quietly deletes the
user's events.

### The classification change

New `bot-challenge.ts` in url-extract:

```ts
export class BotChallengeError extends Error {
  // name = "BotChallengeError" — a cross-plugin contract with classify-error.ts
  static inPlainMode(m: BotMitigation): BotChallengeError;
  static afterRender(status: number, m: BotMitigation | null): BotChallengeError;
}
```

Not `extends NonRetryableError`: the base constructor sets `name`, the brand
would make `run-source` skip its wrap branch, and the class hierarchy buys
nothing a name-based classifier uses.

Exact user-facing strings (both under `shortMessage`'s 300-char ceiling, remedy
before any URL so it can never be the part that truncates):

- plain mode — `This page answers automated requests with a bot challenge (HTTP 429, x-vercel-mitigated: challenge). Set this source's Fetch mode to "Browser render" to load it in a real browser.`
- browser also refused — `A bot challenge blocks this page and a real browser did not get past it either (HTTP 429, x-vercel-mitigated: challenge, then HTTP 429 in a browser). This page cannot be read automatically — remove the source, or point it at a URL that is not behind the challenge.`

`classify-error.ts` gains `bot_challenge` to `RefreshErrorCode` and one arm after
the `SsrfError` arm (both are "the target refuses us"). The comment must earn the
exception to the module's transient-by-default rule: the source type raises this
only *after* trying the one thing that could change the answer, or after the user
explicitly configured it not to — what remains is a standing property of the
site, not of the moment. **The narrowness is the safety**: a bare 429 with no
mitigation evidence never reaches this arm.

No migration and no web edit — `lastErrorCode` is free text and the status
section interpolates it raw.

### Risk: could this stamp `disappearedAt` on the user's events?

The mechanism, once: an empty extraction is a documented success, and
`markEventsDisappeared` is then called with an empty seen-set. Every risk is an
instance of that.

| Risk | Prevented by |
|---|---|
| Browser returns a pre-hydration skeleton | Primitive contract: **throw on timeout, never return partial HTML**. Plus `assertReadable`. **Residual: a partially-hydrated page with chrome but no cards is undetectable from here** — the sharpest edge of this change, and an acceptance criterion on the primitive. |
| User flips `browser` → `plain` on an SPA (*introduced by this change*) | `assertReadable`. Residual: a shell with some chrome text slips through. |
| `auto` escalates, browser is down, we fall back to the challenge page | **There is no fallback, in either direction.** A `browserFetch` throw propagates as an ordinary transient error; a challenge response is never returned as a page. Do not add a fallback later — it converts an infrastructure blip into data loss. |
| Escalation makes a page shorter | Structurally impossible — escalation only happens on a response the plain path was going to throw on. |
| Browser gets 200 serving a challenge *page* with prose | Not detectable without body sniffing, which we refuse. Only the systemic fix below covers it. |

**Recommended follow-up task, out of scope here** (this is the real fix): in
`run-source.ts`, when an extraction yields 0 events and the source currently has
live events, record the run with a flag and **skip** `markEventsDisappeared` on
the first such run, stamping only after a second consecutive empty extraction. A
genuinely emptied listing still clears one tick later, and every failure mode
above stops being destructive.

Also priced, not correctness risks: `auto` on a permanently challenged site pays
a wasted plain fetch every tick (setting `browser` explicitly skips it — do
**not** make `auto` self-teaching by writing back to the config); and a site that
challenges *intermittently* flips the fingerprint and pays one extra Sonnet call
per tick, bounded and never destructive.

---

## Files

**New** — `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/`:
`CLAUDE.md`, `package.json`, `core/{index.ts,internal/{ensure-chromium.ts,bot-mitigation.ts}}`,
`provision/index.ts`, `scripts/verify.ts`,
`server/index.ts`, `server/internal/{browser-fetch,launch-args,request-policy,subresource-proxy,errors,pool}.ts`
plus `{launch-args,request-policy,errors,bot-mitigation}.test.ts`.

**Modified:**
- `plugins/infra/plugins/host-admission/core/internal/budget.ts` — the `RESERVED_POOLS` entry.
- `plugins/framework/plugins/tooling/plugins/e2e-harness/provision/index.ts` — delegate to `ensureChromium()`.
- `plugins/apps/plugins/events/plugins/sources/plugins/url-extract/core/internal/config.ts` — the field.
- `.../url-extract/server/internal/probe.ts` — `fetchPage` / `renderPage` / `readPage` / `assertStatus` / `assertReadable`.
- `.../url-extract/server/internal/source-config.ts` — narrow `fetchMode`.
- `.../url-extract/server/internal/bot-challenge.ts` (new) + `probe.test.ts`, `bot-challenge.test.ts`.
- `plugins/apps/plugins/events/plugins/refresh/server/internal/classify-error.ts` + `.test.ts`.
- `package.json` (root) — keep the devDependency; the plugin declares its own.
- CLAUDE.md: url-extract (the "4xx terminal while 408/429/5xx retry" bullet becomes
  wrong as stated), refresh (the terminal-names list), the new plugin's own.

---

## Verification

1. `./equin build` — regenerates the plugin registry, provision registry and
   docs; runs checks (`plugins-registry-in-sync`, `plugins-doc-in-sync`,
   `host-budget`, `type-check`, boundaries).
2. `./equin test plugins/infra/plugins/safe-fetch/plugins/browser-fetch` and
   `./equin test plugins/apps/plugins/events` — the pure suites. The
   security-critical ones: `request-policy` must block
   `http://169.254.169.254/`, `http://127.0.0.1:9000/`, `file:///etc/passwd`;
   `launch-args` must assert `MAP * ~NOTFOUND` is present and that
   `--no-sandbox` / `--ignore-certificate-errors` never appear.
3. Manual primitive drive:
   `bun plugins/infra/plugins/safe-fetch/plugins/browser-fetch/scripts/verify.ts <url>`
   against three known cases — `shotgun.live` (expect 200 + ~340 KB where plain
   fetch gets 429), `desmotsetdesarts.com` (expect real event content, which
   proves the cross-origin proxy path works), and a private target (expect
   `SsrfError`). The orchestrator cannot be unit-tested against a local fixture
   server because it correctly refuses `localhost` — **do not add a test-only
   SSRF bypass flag.**
4. End to end in the UI at `http://<worktree>.localhost:9000/events/sources`:
   open the Shotgun source, confirm the **Fetch mode** radio renders (Auto
   selected, no migration), hit **Refresh now**, and confirm the run lands
   `extracted` with events created. Cross-check with
   `query_db`: `select outcome, events_found, events_created, error from event_source_runs where source_id = 'evs-1786143870403-ywmcwd' order by started_at desc limit 3`.
5. Negative path: set the Shotgun source to **Plain fetch**, Refresh now, and
   confirm the source parks `status: error` with `last_error_code = 'bot_challenge'`
   and the remediation sentence — and that graphile dead-letters after **one**
   attempt rather than three.
6. `thursday.com` (cookie wall) on **Browser render**: confirm it fails with the
   "behind a cookie or sign-in wall" message rather than silently extracting zero
   events and burying anything.
