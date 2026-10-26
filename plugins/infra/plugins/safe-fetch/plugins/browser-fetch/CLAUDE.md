# browser-fetch

`browserFetch(url)` reads a page with a real headless Chromium, for the two
cases a plain HTTP client cannot read at all: an origin whose bot mitigation
keys on the **TLS/client fingerprint** (no header set can disguise it —
verified: shotgun.live answers a full Chrome header set with `429
x-vercel-mitigated: challenge`, and headless Chromium with `200`), and pages
whose content only exists **after JS runs**.

A sub-plugin of `safe-fetch` because these are two implementations of one idea —
read a public URL without ever reaching a private address — and this one is
built out of the parent's four primitives (`parsePublicUrl`,
`assertResolvesPublic`, `isPrivateIp`, `SsrfError`).

## Launch-per-call, closed in `finally`

**Settled by a security fact, not by taste.** `--host-resolver-rules` is a
Chromium *launch* flag and is the only mechanism inside Chromium that pins DNS.
A warm/reused browser therefore has exactly three options for a second host:
resolve it with Chromium's own unguarded resolver (throwing away the
DNS-rebinding protection `safe-fetch` exists to provide), relaunch anyway (which
*is* launch-per-call), or grow an in-process forward proxy — hundreds of lines
of TLS tunnelling plus a second copy of the pinning logic that can drift from
the first.

The secondary arguments agree: there is no precedent for a supervised
long-lived child process inside a Bun `server/` process (long-lived
supervision belongs to the Go gateway), and a warm browser would
need crash detection, restart backoff, zombie reaping across `./equin
build` restarts, and an idle timer — in up to ~16 worktree backends at once
(~4 GB of idle Chromium). Amortization is near zero anyway: callers are
minutes-apart cron ticks with a per-target dedup key.

**Accepted cost, stated plainly:** ~4.2 s of launch + close on every call.
An interactive "refresh now" takes ~5–6 s instead of ~1 s.

## SSRF

Pre-flight, before anything is spawned *and before pool admission* (a refusal
must never queue behind a slot): `parsePublicUrl` then `assertResolvesPublic`,
which returns the validated IP.

| Layer | Covers | Does NOT cover |
| --- | --- | --- |
| `MAP <host> <ip>` launch arg | pins the target to the address we validated; SNI + cert stay bound to the real hostname | anything not resolved by name |
| `MAP * ~NOTFOUND` (**always last**) | every other *hostname*, incl. prefetches, beacons, cross-host redirects | **bare IP literals** — no lookup happens |
| `parsePublicUrl` on every intercepted request | bare IP literals (`http://169.254.169.254/`), non-http schemes, loopback | WebSockets, WebRTC/QUIC (see gaps) |
| `safeFetch` proxy for cross-origin subresources | full guard (literal reject, per-hop DNS revalidation, IP pinning) on every third-party asset | — |

The third row is **the single most important line in the plugin**: the resolver
rules are inert against a request that performs no DNS lookup, so trusting them
alone would leave a live cloud-metadata hole inside a browser running hostile JS.
Pinned by `request-policy.test.ts`.

Cross-origin subresources are **proxied, not blocked**: blocking them outright
would break every SPA whose bundle lives on a third-party CDN, and break it *as
a silently empty page* — the failure shape a consumer cannot distinguish from
"this site has nothing on it".

Redirects to a **new host** need a relaunch (the pin is a launch arg): the route
handler reports the target, the loop revalidates it and relaunches pinned to it,
up to `maxRedirects` (3 — each hop costs ~4 s, vs `safeFetch`'s 8). Same-host
redirects need nothing; `MAP` binds a hostname regardless of scheme or path.

### Residual gaps, stated honestly

1. `context.route` does not cover **WebSockets** — `page.routeWebSocket("**")`
   closes them. WebRTC/QUIC to an IP literal is not interceptable at all.
   `MAP * ~NOTFOUND` still blocks anything hostname-based, so the surviving hole
   is a private IP literal over a non-routable channel.
2. **We execute attacker-controlled JS.** `safeFetch` returns bytes we parse;
   this runs a full JS engine on hostile input in the user's own account. A
   Chromium sandbox escape is a materially larger blast radius. Mitigated by:
   sandbox **on**, ephemeral profile, no downloads, no service workers, JS heap
   capped at 512 MB. **Never add `--no-sandbox` or `--ignore-certificate-errors`
   / `ignoreHTTPSErrors`** — pinned by `launch-args.test.ts`.
3. Chromium's DNS cache is per-launch, so there is no cross-call rebinding
   window — a bonus of launch-per-call that disappears the moment a warm browser
   is reintroduced.
4. The **network budget** is best-effort: only a declared `content-length` is
   countable without buffering, so a chunked response with no length is
   invisible to it (proxied subresources are counted exactly). The hard ceiling
   is `maxHtmlBytes` on the serialized DOM.

## Bounds — and why a timeout throws

| Bound | Default | On breach |
| --- | --- | --- |
| Playwright module load | shares the launch budget | `browser-unavailable` |
| chromium not installed yet | — (checked before admission) | `browser-unavailable`, `reason: "installing"` (install requested) |
| chromium install failed | — | `browser-unavailable`, `reason: "install-failed"` (not re-requested) |
| launch | 30 s | `browser-unavailable`, `reason: "launch-failed"` |
| navigation | 20 s | `navigation-timeout` / `navigation-failed` |
| settle (`networkidle`) | 3 s | **not a failure** — the ceiling is the expected path |
| `waitForSelector` | `settleMs` | `selector-timeout` |
| network bytes | 24 MiB | `network-budget-exceeded` |
| serialized DOM | 8 MiB | `html-too-large` — **never a truncated page** |
| redirects | 3 | `too-many-redirects` |
| whole op | 45 s | `aborted` (clock starts *after* pool admission) |

**A partially-rendered page is never returned.** A short `html` with a `200`
status is indistinguishable downstream from a site that genuinely has nothing on
it, and that is the one input that can make a consumer silently delete records.
So a timeout throws, and `html-too-large` throws rather than truncating.

`status` is a field on the **success** value (a 404 still renders HTML; the
caller owns what a 404 means, exactly as `safeFetch` callers own
`assertFetched`). `SsrfError` **propagates unwrapped** so a caller classifying
`name === "SsrfError"` classifies both transports identically —
`BrowserFetchError` would silently downgrade a terminal refusal to a transient.
`browser-unavailable` is deliberately an *operator* problem, so callers should
keep it transient: parking a source over a missing binary would be a lie.

## Chromium is an on-demand dependency, and never installed from here

Chromium is `chromium` in `deps/index.ts` — an `infra/deps` dependency of the
`playwright-browser` kind, installed into the deps cache (~280 MB download,
~600 MB on disk) the first time anything needs it; nothing downloads it at
`bun install`. `browserFetch` is a request path, so it only READS:
`readyNow(chromium)` before pool admission. Not installed yet →
`requestDep(chromium)` (enqueues the `deps.install` job and returns at once)
and throw `BrowserUnavailableError` with `reason: "installing"`. Install
failed → `reason: "install-failed"`, carrying the failure, and NOT requested
again (every read would otherwise start another doomed download). Installed →
`launchChromium(ready, …)` from the kind, which takes the `Ready`, so a launch
without an installed browser cannot be spelled.

The reason this matters is a real defect, not tidiness. The installer once
lived in `core/` as `ensureChromium()`, and the prototype thumbnail render
called it: a missing binary meant a backend blocking its **entire event loop**
on a synchronous ~150 MB download — no health endpoint, no live-state, no jobs,
invisible to the queue-health watchdog. The engine's `ensureDep` demands an
`ExecContext` for exactly that reason.

Every flavour of `browser-unavailable` stays transient for a classifying
caller: parking a source over a browser that is still installing would be a
lie. `scripts/verify.ts` is not a backend, so it installs first
(`ensureDepViaCli`, progress on the terminal).

## Concurrency

`withBrowserSlot` mirrors `host-read-pool`'s two-tier shape — a host-wide
`browser-fetch` pool (size 2, declared in `host-admission/core`'s `HOST_POOLS`;
a cardinality cap on concurrent launches, claiming no CPU) behind a
**per-worktree local gate of 1**, so one backend's
batch of jobs cannot present N waiters and starve another worktree's single
interactive render. There is **no `AsyncLocalStorage` reentrancy guard** (a
browser fetch never nests in a browser fetch) — do not copy that block across
for symmetry. Do not reuse the `heavy-read` pool: it is sized for git/fs reads
and sits on the interactive live-state loader path.

Playwright is **dynamically imported** on first use (then memoized): its module
evaluation costs ~1–3 s, which a backend must never pay at boot merely because
something in its graph can start a browser. Keep it dynamic. `core/` carries no
Playwright import at all, so a consumer that only wants `detectBotMitigation`
pays nothing.

That import is the one step with no `timeout` option of its own, so it is bounded
by hand through `withDeadline` (`packages/deadline`) against the same whole-op clock as
every other step — **every** `await` on this path must answer within the budget,
or the budget is a fiction. A deadline-expired import keeps its memo (it is still
in flight; a second concurrent import would orphan the first); only a *rejected*
one clears it.

## `detectBotMitigation` (core)

Pure `(status, headers) → BotMitigation | null`. It answers "is a browser the one
thing that would change this answer?" — this plugin's own domain knowledge, not a
consumer's HTTP policy. Only `x-vercel-mitigated` is *verified*; `cf-mitigated`
is vendor-documented but unobserved; the `server: cloudflare` + `cf-ray` branch
is labelled inference and is **not** extended to 503 (a Cloudflare 503 is just as
likely an origin outage). No Akamai/DataDome/PerimeterX guesses, no body
sniffing, never fires on a 2xx, and **a bare 429 with no header is not
mitigation** — that is the real rate-limit case and it must keep retrying.

## Verifying

The orchestrator **cannot** be unit-tested against a local fixture server — it
correctly refuses `localhost`, and a test-only SSRF bypass flag would put a hole
in the one guarantee it sells. The pure halves are unit-tested; the wiring is
proven by hand:

```bash
./equin run plugins/infra/plugins/safe-fetch/plugins/browser-fetch/scripts/verify.ts \
  https://shotgun.live/en/venues/paris-erasmus-life   # 200, ~340 KB (plain fetch: 429)
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Browser-backed page read for URLs a plain HTTP client cannot read: launch-per-call headless Chromium pinned to one validated IP via --host-resolver-rules (MAP <host> <ip>,MAP * ~NOTFOUND), every intercepted request re-guarded with parsePublicUrl, cross-origin subresources proxied through safeFetch, bounded by a size-2 host pool. Throws on timeout rather than returning a partially-rendered page.
- Server:
  - Uses:
    - `infra/deps.requestDep`
    - `infra/host/host-admission.defineHostPool`
    - `infra/safe-fetch.assertResolvesPublic`
    - `infra/safe-fetch.parsePublicUrl`
    - `infra/safe-fetch.safeFetch`
    - `infra/safe-fetch.SsrfError`
  - Exports (types):
    - `BrowserFetchFailureKind`
    - `BrowserFetchInit`
    - `BrowserFetchResult`
    - `BrowserFetchTimings`
    - `BrowserUnavailableReason`
  - Exports (values):
    - `browserFetch`
    - `BrowserFetchError`
    - `browserFetchQueueDepth`
    - `BrowserUnavailableError`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/playwright-browser.playwrightBrowser`
  - Exports (values): `chromium`
- Cross-plugin:
  - Imported by: `apps/events/sources/url-extract`
- Core:
  - Exports (types):
    - `BotMitigation`
    - `HeaderReader`
    - `HeaderSource`
  - Exports (values): `detectBotMitigation`

<!-- AUTOGENERATED:END -->
