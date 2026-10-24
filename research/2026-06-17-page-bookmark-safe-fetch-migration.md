# Migrate bookmark scraper to infra/safe-fetch primitive

**Date:** 2026-06-17  
**Category:** page

---

## Context

`plugins/page/plugins/bookmark/server/internal/scrape.ts` contains a private, inline SSRF guard
with three helper functions (`isBlockedHost`, `guardUrl`, `safeFetch`). These duplicate work that
`plugins/infra/plugins/safe-fetch` now owns — a production-hardened primitive already used by the
browser proxy. The inline guard has two known weaknesses:

1. **No DNS resolution** — it only pattern-matches the hostname string, so a DNS rebind or CNAME
   that resolves to a private IP passes through unchecked. The infra primitive adds
   `assertResolvesPublic` which resolves all A/AAAA records on both the initial URL and every
   redirect hop.
2. **CGNAT gap** — `isBlockedHost` misses `100.64.0.0/10` (CGNAT) and unequal IPv4-mapped IPv6
   (`::ffff:x.x.x.x`) ranges that `isPrivateIp` in the infra primitive covers.

Migration removes the duplication, closes both gaps, and gives the scraper per-hop DNS revalidation
on redirects without any extra code.

---

## Files

| File | Role |
|---|---|
| `plugins/page/plugins/bookmark/server/internal/scrape.ts` | **Primary change** — delete inline guard, import from infra |
| `plugins/page/plugins/bookmark/server/internal/handle-link-preview.ts` | **Secondary** — catch `SsrfError` → HTTP 400 |
| `plugins/infra/plugins/safe-fetch/server/index.ts` | Source of truth (read-only) |

---

## Design

### 1. `scrape.ts` — replace inline guard with infra imports

**Delete** these three private functions entirely:
```ts
// DELETE
function isBlockedHost(hostname: string): boolean { … }
function guardUrl(raw: string): URL { … }
async function safeFetch(initial: URL): Promise<Response> { … }
```

**Add** imports at the top:
```ts
import {
  parsePublicUrl,
  safeFetch,
  SsrfError,
} from "@plugins/infra/plugins/safe-fetch/server";
```

**Replace call sites** (two places in the file):

| Old | New |
|---|---|
| `const target = guardUrl(url)` | `const target = parsePublicUrl(url)` |
| `const res = await safeFetch(target)` | `const res = await safeFetch(target)` (same name, but now DNS-hardened; accepts `URL`) |
| `const imgUrl = guardUrl(src)` inside `cacheImage` | `const imgUrl = parsePublicUrl(src)` |
| `await safeFetch(imgUrl)` in `cacheImage` | `await safeFetch(imgUrl)` (unchanged call) |

No logic changes needed — `parsePublicUrl` has identical call signature to `guardUrl` (`string → URL`),
and `safeFetch` from infra accepts `string | URL` (same or wider).

**Delete** the `FETCH_TIMEOUT_MS`, `MAX_REDIRECTS`, and `MAX_HTML_BYTES` constants that were
only used by the deleted functions. Keep `MAX_IMAGE_BYTES` if it's used elsewhere in the file
(check during implementation).

> **Timeout change:** old code used `AbortSignal.timeout(8000)` *per hop* (max 40s across 5
> redirects). New default is `20_000 ms` *total* across all hops. This is a tighter overall bound,
> appropriate for link preview use (8 hops max by default). Pass `timeoutMs: 8000` as `SafeFetchInit`
> if the current per-hop semantics are important — but the global deadline is strictly safer.

### 2. `handle-link-preview.ts` — map `SsrfError` to HTTP 400

`scrapeLinkPreview` previously threw `HttpError(400)` for SSRF violations. After migration it
throws `SsrfError`. The handler must convert it:

```ts
import { SsrfError } from "@plugins/infra/plugins/safe-fetch/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";

// inside implement(linkPreviewEndpoint, async (req) => { … })
try {
  return await scrapeLinkPreview(query.url);
} catch (err) {
  if (err instanceof SsrfError) throw new HttpError(400, err.message);
  throw err;
}
```

This preserves the existing HTTP 400 behaviour visible to the client, while using the correct
domain error type internally.

---

## Verification

1. **Build** — `./equin build` must pass (type-check, boundary checks, migrations-in-sync).
2. **Happy path** — open a bookmark pane and paste a real public URL (e.g. `https://example.com`);
   confirm title/favicon appear in the preview.
3. **SSRF block** — send `GET /api/link-preview?url=http://localhost` from browser devtools;
   expect 400 response.
4. **SSRF block (CGNAT)** — send `GET /api/link-preview?url=http://100.64.0.1`; expect 400.
   (This would have slipped through the old guard but is now blocked by `isPrivateIp`.)
5. **Redirect guard** — confirm no regression on normal redirecting URLs (e.g. a URL that 301s
   to its canonical form).

No automated tests exist for this path; the verification is manual via devtools / Playwright.
