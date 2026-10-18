# url-extract

The `url` source type: paste a venue URL, get structured events. No per-site
scraper — a one-shot Sonnet call reads the page.

`probe` fetch → strip → normalize → `sha256`; `extract` prompt → parse. The
engine (`events/refresh`) owns the phase order and the fingerprint cache; this
plugin owns only the HTTP and the LLM.

## Fetch mode: one branch, and nothing downstream sees it

`fetchPage()` is the ONLY place the transport is chosen (plain `safeFetch` vs
`browser-fetch`); it returns a `FetchedPage` whose `via` is message copy, never
control flow. `readPage()` does the rest — both renderings, all three bounds,
`assertReadable`, the fingerprint — so starting a browser can change how bytes
were obtained, never what the page **means**. `readPage` is network-free, which
is what makes the half that decides "is this safe to hand the model" testable.

The **Fetch mode** field (`core/internal/config.ts`): `auto` (default) / `plain`
/ `browser`. `auto` escalates only on a *failing* response carrying
bot-mitigation evidence — **never on a 200, however thin.** A thin-200 rule could
only be a content threshold, and a threshold makes the same URL yield plain text
one tick and browser text the next: the fingerprint flips and a Sonnet extraction
is paid for every 15 minutes. It can also go *backwards* (a slow/unavailable
browser hands the model a shorter page, which is how the engine is told a listing
emptied).

`enumField`, never `enumTextField` — the latter's `type` is `textFieldType`, so
`FieldRenderer` would draw a free-text input. The `string` → union narrowing
happens once, in `source-config.ts`, and **throws**; a `?? "auto"` would turn an
unrecognised mode into a silent plain fetch.

**No fallback in either direction — do not add one.** A `browserFetch` throw
propagates as an ordinary transient error; a challenge response is never returned
as a page. A fallback converts an infrastructure blip into data loss.

## A bot challenge is terminal, and only a bot challenge is

`detectBotMitigation` (the primitive's `core/` — "would a browser change this
answer" is its knowledge, not our HTTP policy) is consulted **before**
`assertStatus`, because both of that rule's readings are wrong for a challenge:
4xx parks the source claiming the URL is bad, 429 retries a refusal that has made
up its mind. (shotgun.live: every page answers `429` +
`x-vercel-mitigated: challenge` in ~200 ms under a `robots.txt` saying
`Allow: /`; headless Chromium gets 200 immediately.)

`BotChallengeError` (`bot-challenge.ts`) → `refresh`'s `bot_challenge`, terminal.
Two factories: `inPlainMode` (user pinned `plain`; message names the field and
the value) and `afterRender` (a real browser was refused too — nothing left to
escalate to). It does **not** extend `NonRetryableError`: that base sets `name`
(the contract the classifier matches) and carries a `Symbol.for` brand that would
make `run-source` skip its wrap branch. A bare 429 with no mitigation evidence
never becomes one and keeps retrying.

## Two renderings of the same bytes — do not merge them

`probe` produces both, for two different jobs (`UrlPagePayload`):

- **`text`** (`page-text.ts`) — the cheapest stable reading, and the ONLY thing
  the fingerprint is taken over.
- **`html`** (`page-html.ts`) — simplified markup, and what the model reads.
  Grouping is the whole point: an `<li>` boundary says which title, date and
  venue are ONE event, where flat text answers that with adjacency alone and a
  table row becomes an ambiguous run of lines. Also keeps `<time datetime>`
  (an exact instant where the prose omits the year), `href`, and `img src/alt`.

parse5, not `HTMLRewriter`: collapsing a single-child wrapper needs to know how
many children it has, and real pages omit `</li>`/`</p>` — only a spec tree
builder puts them back. The output tree and serializer are ours, so `<img>` stays
`<img>`.

## Why it is shaped this way

- **The fingerprint is over the normalized visible TEXT, never the markup.**
  Markup carries a CSRF nonce, ad-slot cache-busters, and asset build hashes that
  move on every request, so hashing it reports "changed" every tick and pays for
  an extraction each time — defeating the entire probe/extract split.
- **Stripping is a separate rewriter pass** (`page-text.ts`). The one-pass
  alternative needs `el.onEndTag()`, and Bun's rewriter throws
  `HTMLRewriterError: No end tag.` on an ordinary self-closing `<svg/>`.
  `chunk.removed` is not a substitute — text handlers fire for removed content.
- **Entities are decoded exactly once, over the whole accumulated string**, not
  per chunk: the rewriter splits text on its own buffer boundaries, so a
  character reference can straddle two chunks.
- **A response the parser cannot vouch for throws `NonRetryableError` carrying an
  excerpt of the raw output** (`parse-response.ts`). Returning `events: []` would
  read to the engine as "the page genuinely lists nothing" and stamp
  `disappearedAt` on every event this source ever found. There is deliberately no
  fallback for the pre-recurrence bare array: one format, loud on a stale shape.
- **The call is stamped with `ctx.runId`** (`correlationId`), which is what lets
  a run's own pane show the prompt and output that produced it — the call log
  stays the single copy of that text, never duplicated into the events schema.
- **The prompt states recurrence ONCE, never materializes it**: a weekly night is
  one event whose `date` carries the rule. The format's own description of itself
  (`EVENT_DATE_PROMPT_SPEC`, from the `event-date` plugin) is interpolated into
  the prompt, so spec / parser / expander cannot drift.
- **The response envelope is `{"events": [], "flags": []}`.** `flags` is global to
  the page — one entry per schedule the `date` format could not hold. Not a
  commentary channel, and never a substitute for omitting an event whose date is
  undeterminable.
- **The bound is on visible TEXT (200k chars), not markup bytes.** A byte offset
  says nothing about where content is — Wix pages hide `<body>` behind ~700 KB of
  inline `<style>`. `MAX_HTML_BYTES` (8 MB) is only a DoS backstop; do not shrink
  it back into a content bound.
- **A page not read whole THROWS, never becomes a shorter page.** Truncated
  markup parses fine, so a partial read is silent — the model extracts what
  little it saw, and `runSource` reads an empty extraction as "the listing
  emptied" and stamps `disappearedAt` on every event the source ever found.
  `assertReadable` extends the same refusal to a page with **no** readable text:
  the test is `text.trim().length === 0`, a fact, never "fewer than N chars" —
  a threshold would park a venue that is genuinely between seasons.
- `safeFetch` is mandatory on the plain path (SSRF + DNS-rebinding); the body is
  read into bytes and the reader cancelled (NOT a piped `TransformStream` —
  Bun's `HTMLRewriter.transform()` refuses one with `ERR_STREAM_CANNOT_PIPE`);
  `assertStatus` takes a bare status so both transports are judged alike — a 4xx
  is terminal while 408/429/5xx retry, *after* the mitigation check above.
  `renderPage` re-runs `assertResolvesPublic` itself: the browser does its own
  DNS and redirects, so `safeFetch`'s pinned dial protects nothing there.

The add/configure form is rendered generically from `core/`'s `configFields` —
**this plugin ships no form code**, and neither should the next source type.

Design: [`research/2026-08-03-apps-events-event-tracking-app.md`](../../../../../../../../research/2026-08-03-apps-events-event-tracking-app.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Web-page source type in the Events `+` menu: contributes the `url` type with its generic URL + extraction-hint form. Web-page event source type: probe reads the URL through one transport-blind pipeline (SSRF-guarded plain fetch, or a real browser when the source's Fetch mode says so or the site answers a bot challenge), refuses a page it cannot read whole or that has no readable text at all, and fingerprints its normalized visible text; extract turns that text into structured events with a one-shot Sonnet call, validated against ExtractedEventSchema.
- Web:
  - Contributes: `EventSources.Type` "Web page"
  - Uses: `apps/events/events-core.EventSources`
- Server:
  - Uses:
    - `apps/events/events-core.defineEventSourceType`
    - `infra/claude-cli.runClaudePrint`
    - `infra/jobs.NonRetryableError`
    - `infra/safe-fetch.assertResolvesPublic`
    - `infra/safe-fetch.parsePublicUrl`
    - `infra/safe-fetch.safeFetch`
    - `infra/safe-fetch/browser-fetch.browserFetch`
  - Register: `defineEventSourceType('url')`
- Core:
  - Uses:
    - `fields.nullable`
    - `fields/enum/config.enumField`
    - `fields/text/config.textField`
  - Exports (types):
    - `UrlFetchMode`
    - `UrlSourceConfig`
  - Exports (values):
    - `URL_FETCH_MODES`
    - `URL_SOURCE_TYPE_ID`
    - `urlSourceConfigFields`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/page-text.ts` (debt)

<!-- AUTOGENERATED:END -->
