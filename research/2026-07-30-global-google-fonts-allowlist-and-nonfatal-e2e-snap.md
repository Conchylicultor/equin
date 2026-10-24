# Google Fonts: catalog allowlist, and a diagnostic screenshot that can't fail a green run

**Date:** 2026-07-30
**Category:** global (`plugins/ui/tokens/font-family/google-fonts` + `plugins/framework/tooling/e2e-harness`)

## Context

On every boot the app injects `<link rel="stylesheet">` elements to `fonts.googleapis.com`
for font families that are **system fonts, not Google Fonts** — `SFMono-Regular`,
`Liberation Mono`, `Segoe UI Symbol`, `Segoe UI Emoji`, `Apple Color Emoji`,
`Helvetica Neue`. The requests fail (`ERR_BLOCKED_BY_ORB`) and `document.fonts.ready`
never settles.

Two consequences: pointless cross-origin requests to Google on every boot, and —
because Playwright's `page.screenshot()` awaits `document.fonts.ready` with a 30s
default — a cosmetic screenshot that can abort an otherwise-green e2e run. This was
hit for real: `page/editor`'s `inline-format-verify.ts` died on a `snap()` after 31
assertions had already passed.

Both surfaced while implementing inline markdown shortcuts; neither is caused by that
change.

### Root cause

A CSS font stack is a *fallback chain* mixing one intended font with local backups:

```css
--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

Nothing in that stack is meant to be downloaded — but the names alone don't say so.
`google-fonts-loader.tsx:82` parses every family out of `fontSans`/`fontSerif`/`fontMono`
and filters them through `shouldLoadFont` — a **hand-maintained denylist of 22 system
font names** (`should-load-font.ts`).

That filter is the wrong shape: it enumerates an *open, unbounded* set (every OS keeps
adding font names), and it is already full of near-misses — it has `SF Mono` but not
`SFMono-Regular`, `Segoe UI` but not `Segoe UI Emoji`, `Helvetica` but not
`Helvetica Neue`.

The offending stacks are **not ours**. Our own default preset is self-hosted
(`'Inter Variable'` / `'Cascadia Code Variable'` via `@fontsource-variable/*` imported in
`ui-kit/web/theme/app.css`). The system-font names arrive from the 522 third-party
themes in `plugins/ui/plugins/tweakcn/plugins/community-browser/shared/catalog.json`,
whose authors legitimately wrote system stacks. As long as we accept imported themes we
will keep seeing arbitrary font names, so the loader needs a reliable way to answer
*"can Google actually serve this name?"*

### Evidence gathered

Parsing the 522-theme tweakcn catalog through the current loader logic:

| | count |
|---|---|
| distinct families the loader requests today | **154** |
| of those, not on Google Fonts | **43** |
| caught by the current 22-name denylist | ~22 |

The 43 rejects include every reported family plus ~20 the denylist misses:
`Bitstream Charter`, `Book Antiqua`, `Charter`, `Chillax`, `Courier`, `Garamond`,
`Geist Sans`, `Hoefler Text`, `Inter var`, `Lucida Grande`, `MS Sans Serif`,
`Old English Text MT`, `Palatino`, `Palatino Linotype`, `SF Pro Display`, `Signifier`,
`Source Sans Pro`, `Source Serif Pro`, `Space Grotesk Mono`, and four **`var(--font-*)`
CSS references** being sent to Google as if they were family names.

Confirmed failure mechanism (`curl` against the exact URLs the loader builds):

```
SFMono-Regular       http=400  ctype=text/html; charset=utf-8
Segoe UI Symbol      http=400  ctype=text/html; charset=utf-8
Apple Color Emoji    http=400  ctype=text/html; charset=utf-8
Liberation Mono      http=400  ctype=text/html; charset=utf-8
Inter                http=200  ctype=text/css;  charset=utf-8
```

An **HTML body arriving where a stylesheet was expected** is exactly what Chromium's
Opaque Response Blocking kills → `ERR_BLOCKED_BY_ORB`.

Two secondary findings worth recording:

- **`Helvetica Neue` returns 200**, not 400 — Google serves it via a restricted
  `gstatic.com/l/font?kit=` URL. So it is not part of the hang, but it *is* still wrong:
  we download ~90 KB of Helvetica Neue to satisfy a stack whose intent was the local
  copy. The allowlist rejects it anyway (not in the catalog).
- **The `wght@400;500;600;700` request is not a 400 source.** Single-weight families
  (`Pacifico`, `VT323`, `Bebas Neue`) all return 200 — Google serves the nearest
  available weight, as the comment at `google-fonts-loader.tsx:27-31` claims. Unknown
  *family* is the only 400 cause, so the allowlist is a complete fix for this class.

### Why an allowlist is tractable

"Is this a system font?" is unanswerable — the set is unbounded. "Is this on Google
Fonts?" has exactly one authoritative answer, published at
`https://fonts.google.com/metadata/fonts`: **1,942 families, 25 KB of names**
(~10 KB gzipped). Checked against our real catalog it admits all 126 genuine families
and rejects all 43 fakes.

## Plan

### Part A — replace the denylist with a Google Fonts catalog allowlist

Mirrors the existing precedent in
`plugins/ui/plugins/tweakcn/plugins/community-browser/` byte-for-byte: a dev script
writes a committed data file, and a memoized lazy `import()` keeps it off the boot path.

**A1. NEW** `…/google-fonts/scripts/fetch-catalog.ts` — dev script, modelled on
`community-browser/scripts/fetch-catalog.ts`.

- `GET https://fonts.google.com/metadata/fonts`
- extract `familyMetadataList[].family`, dedupe, sort
- **fail loud** on non-200, unexpected shape, or an implausibly small result (guard
  against committing a truncated catalog — e.g. throw under ~1000 families)
- write `web/internal/google-fonts-catalog.json` as
  `{ "generatedAt": "<ISO date>", "families": [...] }`
- header comment documents the refresh command, as the tweakcn script does

**A2. NEW** `…/google-fonts/web/internal/google-fonts-catalog.json` — the committed
snapshot (~35 KB raw, ~10 KB gz). Lives in `web/internal/` rather than `shared/`: this
plugin has no server runtime, so the data is web-private.

**A3. NEW** `…/google-fonts/web/internal/google-font-catalog.ts` — replaces
`should-load-font.ts` (which is **deleted**). Exports:

```ts
export function loadGoogleFontFamilies(): Promise<ReadonlySet<string>>
```

Memoize the *promise* (not the resolved value) so concurrent callers share one parse —
copy the comment and shape of
`community-browser/server/internal/load-catalog.ts`. The lazy `import()` matters: this
plugin contributes `Core.Root`, so it is eager at every boot, and the catalog must not
land in the boot bundle.

The two `// Bundled locally` denylist entries need no replacement: neither
`Inter Variable` nor `Cascadia Code Variable` is a Google Fonts family name, so the
allowlist rejects both by construction.

**A4. REPLACE** `…/google-fonts/web/internal/parse-font-families.ts` with
`preferred-font-family.ts`, exporting `preferredFontFamily(stack): string | null`.

Two changes, both discovered while measuring the allowlist against the real 522 themes:

- **Reject `var(…)` tokens.** A CSS variable reference is not a family name; four of
  them were being sent to Google verbatim. Matching any parenthesis also covers
  `var(--font-sans, serif)`, which comma-splitting cuts into two non-family fragments.
- **Read only the head of the stack, as written.** A stack is an ordered fallback chain:
  the head is the face the theme wants, and everything after it is what the browser
  should find locally. Downloading a fallback defeats the point of declaring one. Six
  families in our themes appear *only* in fallback position — including
  **`Noto Color Emoji` (~10 MB) in 54 themes**, sitting behind an emoji font every OS
  already ships.

  The head is read *before* generic filtering, because a leading generic is itself a
  preference: `ui-monospace, 'Cascadia Mono', Menlo, monospace` asks for the OS mono
  face, and promoting the first non-generic entry would download Cascadia Mono anyway.
  Measured across all 522 themes, reading the literal head rather than the first
  non-generic entry costs nothing real — the only two families it drops are exactly
  those `Cascadia` fallbacks.

The allowlist alone would have *added* one request (`Roboto`, which the old denylist
wrongly suppressed as a system font — it is a genuine Google Font, and also a Tailwind
fallback). The head rule is what keeps it from being fetched as a fallback.

**A5. EDIT** `…/google-fonts/web/internal/google-fonts-loader.tsx`

- `collectFontNames` → `collectPreferredFamilies`: one head per stack, not every name
- resolve the catalog into state via a mount-time effect (`cancelled` guard), then
  filter inside the existing `fontsToLoad` `useMemo`

  Resolving into state rather than awaiting inside the link effect keeps that effect
  synchronous **and** keyed on the *filtered* set. Keying it on unfiltered candidates
  would mean two themes differing only in their system fallbacks produce different
  keys — and since the effect's cleanup removes every `link[data-google-font]`, each
  re-run tears down and re-requests every font sheet.
- the link effect and its `fontsKey` dep stay exactly as they are today

**A6. NEW** `…/google-fonts/web/internal/google-font-catalog.test.ts` and
`preferred-family.test.ts` (`bun:test`, beside the source per the repo convention) —
regression lock on the six reported families, the near-misses the old denylist let
through, `var(…)` references, the Tailwind default stacks, and fallback-position
`Roboto` / `Noto Color Emoji`.

### Measured effect (all 522 imported themes)

| | before | after |
|---|---|---|
| distinct families requested | 154 | 118 |
| **non-existent** families requested | **29** | **0** |
| total stylesheet requests | 1,638 | 1,057 (**35% fewer**) |
| `Noto Color Emoji` (~10 MB) fetched | yes | no |

### Part B — a diagnostic screenshot must not fail a green run

A screenshot is a *diagnostic*, not an assertion. Today `snap()`
(`e2e-harness/e2e/shots.ts:17`) passes no timeout, so it inherits Playwright's 30s
default and throws — aborting the script. Fixed loudly, not silently: the failure is
printed when it happens **and** surfaces in the run summary; only the exit code stops
depending on it.

**B1. NEW** `e2e-harness/e2e/diagnostics.ts` — `pushDiagnostic(line)` /
`drainDiagnostics()`. A module-level per-process channel, which is consistent with
`report()` already owning `process.exit`.

**B2. EDIT** `e2e-harness/e2e/shots.ts`

- `page.screenshot({ path, timeout })` with a bounded default (~10s), overridable
- never throws; on failure logs `SNAP-FAIL <path> — <message>` and calls
  `pushDiagnostic`
- return a discriminated result, not an absorbable value (repo rule — no `null`/`""`):

```ts
export type SnapResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string };
```

Safe to change: all **29** current `snap()` call sites ignore the return value.

**B3. EDIT** `e2e-harness/e2e/report.ts` — `finish()` drains diagnostics and prints them
under a `DIAGNOSTICS (non-fatal)` heading. Exit code stays driven by assertions alone.

**B4. EDIT** `e2e-harness/e2e/index.ts` — export `SnapResult` (and `pushDiagnostic`, so
future non-assertion helpers use the same channel).

Deliberately **not** setting `PW_TEST_SCREENSHOT_NO_FONTS_READY=1`: keeping the font
wait means screenshots still render with real fonts in the normal case, and the bound
plus non-fatal handling already removes the failure mode. Noted here so a future reader
knows the escape hatch exists.

## Verification

1. `./equin build`
2. `bun test plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/web/internal/`
   — the new regression tests.
3. `./equin check` — `plugins-doc-in-sync` (files added/removed) and
   `plugin-boundaries` (a `scripts/` folder is precedented by tweakcn).
4. **Re-run the run that died:**
   `bun plugins/page/plugins/editor/e2e/inline-format-verify.ts` — expect all assertions
   green *and* the trailing `snap()` to complete.
5. **Confirm the requests are gone.** Drive the app with a tweakcn theme whose stack
   carries system fonts, and assert on `capture().failedRequests` from the harness — it
   should contain no `fonts.googleapis.com` entries. Also confirm in-page that
   `document.fonts.ready` settles.
6. **Confirm the non-fatal path independently of the font fix** — point a throwaway
   script's `snap()` at an unwritable path and check the run still exits 0 with the
   failure printed in the summary. This must hold even after Part A makes the original
   trigger disappear.

> Note: a browser-side probe of the hang (`document.fonts.ready` + `page.screenshot`
> against bogus Google Fonts links) was blocked mid-investigation by the main-branch
> write guard — a false positive on a heredoc body, reported to the user rather than
> worked around. Step 5 covers the same ground against the real app.

## Out of scope (follow-ups)

- **Same-origin font mirroring.** Real Google Fonts are still fetched cross-origin from
  `googleapis`/`gstatic`. Routing them through `infra/asset-mirror` would make the app
  offline-capable and stop leaking user IPs to Google. Not folded in: `asset-mirror`
  mirrors *files under a base URL*, whereas the `css2?family=…` API is query-shaped and
  the CSS it returns embeds `gstatic` URLs that would need rewriting. Genuinely separate
  work.
- **Local aliasing for bundled families.** A theme naming `Inter` downloads Inter from
  Google even though we ship `Inter Variable` locally. Fixing it means rewriting token
  values or adding an `@font-face` alias — that belongs to the `font-family` token group,
  not to this loader, and would turn a bug fix into a font-resolution redesign.
- **Latent churn in the loader effect.** The cleanup removes *all* `link[data-google-font]`
  elements on every re-run, so the `existing` reconcile map can never hit and every
  re-run re-fires all font requests. Harmless today because `fontsKey` is stable, but the
  reconcile is effectively dead code. Left as-is to keep this change scoped.
