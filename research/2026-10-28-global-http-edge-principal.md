# HTTP edge principal: a foreign origin is never the owner

Track: Trust boundaries (page `block-f3f30a77-fa7e-4db0-ab22-be3884857103`), Phase 1. Design: End vision → "The HTTP edge". Evidence: Findings F9.

## Context

The gateway treats every request that reaches `localhost:9000` as the owner. A cross-site POST from `https://evil.example` reaches `POST /api/menu-bar/install/:appId`, which writes `~/Applications`, edits the Dock and restarts it. The only origin check is host-fs's `isAppOrigin`, which three routes copy by hand. Nothing in an endpoint's declaration says who may call it. The same holes:

- `/gateway/*` restart/stop are unchecked.
- WebSocket upgrades are unchecked, and WS is not subject to the same-origin policy, so any site can read all live state.
- Central routes (`/api/secrets/*`, `/api/auth/*`) are served on any Host, so DNS rebinding reaches them.

Outcome:

- An edge (the gateway) turns each request into a **principal**: `owner` or `anonymous`.
- Every route is `owner`-only unless its declaration says `access: { public: "<reason>" }`.
- A repeatable e2e probe proves it.

This is the first slice of Hosted Phase 2 (the Principal seam).

## Decisions (with the user)

- **Default owner, opt-in public.** `defineEndpoint({ access: { public: "<reason>" } })` is the only spelling. Omitting it is `owner`. A forgotten field is therefore the safe answer, so no 375-site codemod. The exit criterion on the track is reworded accordingly.
- **One rule for every method.** An anonymous caller reaches public routes only: GET, writes and WS upgrades alike. This also closes side-effecting GETs and cross-site WebSocket reads. SPA pages are static (gateway) and stay reachable, so pasted app links work.
- **Browser proxy:** removed on main (`aa6a43c814`, Playwright engine host), so no capability token is needed. Nothing legitimate calls equin from an opaque origin any more.

## Who is the owner (the rule, gateway-side)

`principalOf(r)`:

1. The Host is not an equin host (no namespace by `parseWorktree`, and not a loopback literal `localhost` / `127.0.0.1` / `[::1]`) → **anonymous**. This handles DNS rebinding: `evil.com` resolved to 127.0.0.1 is same-origin with itself.
2. `Sec-Fetch-Site` is `same-origin` or `none` (user-typed URL / bookmark) → **owner**.
3. No `Sec-Fetch-Site` and no `Origin` → **owner**. That is a local tool: the CLI, MCP, Bun `fetch`, curl. Browsers always send `Sec-Fetch-Site` and cannot suppress it.
4. No `Sec-Fetch-Site`, and `Origin` == `http://<Host>` → **owner**. This covers older browsers.
5. Anything else → **anonymous**: cross-site, same-site (a sibling namespace), `Origin: null`.

**Same-origin, not same-site.** This answers the End vision's open question without needing it settled: a sibling `<ns>.localhost` is anonymous whether or not browsers treat it as its own site. The inventory found no browser page calling another namespace's API. The worktree preview iframe calls its own origin. The Tauri release app at bare `localhost:<port>` is same-origin with itself.

The OAuth popup is opened at bare `localhost:9000` from a namespace page, which makes it cross-site. It moves to the page's own origin, since central routes are served on every host and `redirect_uri` is host-independent. The callback (a cross-site navigation from Google) is public: it is authenticated by the state nonce an owner request minted.

## Mechanics

### Gateway (Go) — `gateway/principal.go` (new)

- `principalOf(r)` plus a table test.
- In `Proxy.ServeHTTP`, compute the principal once, at the top:
  - Delete any client-sent `X-Equin-Principal` and stamp the verdict, on both the HTTP reverse proxy and the WS replay (`r.Write`).
  - **Refuse at the gateway** (the holder of the power decides):
    - anonymous non-GET/HEAD on `/gateway/*`;
    - anonymous WS upgrades (no public socket exists).
  - Refusal: `403 {"reason":"cross-site-refused","route","message"}`.
- The gateway's own direct-socket calls (`/api/health/ready`, `/api/boot/gateway-report`) stamp `owner`.

### Principal primitive — `plugins/framework/plugins/principal` (new, core leaf)

- `PRINCIPAL_HEADER = "x-equin-principal"`.
- `type Principal = { kind: "owner" } | { kind: "anonymous" }`. Hosted widens it later (device, agent, share link).
- `principalOf(req)`: `"owner"` → owner. Anything else, including a missing header, → anonymous (fail closed).
- `type EndpointAccess = "owner" | { public: string }`.
- `crossSiteRefusedResponse(route)` / `isCrossSiteRefusal`.
- `check/`: `principal:header-in-sync` checks that the Go constant and the TS constant agree.
- `lint/`: `principal/no-origin-header-read` bans reading the `origin` / `sec-fetch-*` request headers outside this plugin, so per-handler checks cannot come back.

### Declaration — `infra/endpoints`

- `EndpointOptions.access?: { public: string }`. `EndpointContract.access: EndpointAccess` is resolved, `"owner"` by default.
- `endpointHandler` / `rawEndpointHandler` attach `access` to the branded handler.
- `EndpointHttpHandler` (server-core `core/types.ts`) gains `readonly access: EndpointAccess`.
- A raw GET handler that is not built by endpoints has no `access`, so it is owner.

### Enforcement — the socket hosts

- `server-core/bin/index.ts` and `central-core/bin/index.ts` wrap every `[route, handler]` pair through one `gateByPrincipal(routes)`, which lives beside `hostHttpRoutes`.
- Per route, decided at registration: public → passthrough; else anonymous → `crossSiteRefusedResponse`.
- A WS upgrade by an anonymous request is refused (403) before `server.upgrade`.
- The in-realm browser host (worker) is not gated: it is the page itself.
- Each host serves its route table, owner-only: `GET /api/host/routes` → `[{route, access}]` (central: its own path in the central manifest). The probe enumerates it.

### Call-site changes

- `auth`:
  - `oauthCallback` → `access: { public: "authenticated by the OAuth state nonce an owner request minted" }`. It is served through `rawEndpointHandler` so the declaration rides.
  - `connect.ts` opens the popup at `window.location.origin`.
- host-fs: delete `isAppOrigin` and its three calls and tests. The default gate now covers them. Update host-fs `CLAUDE.md`.
- Docs:
  - gateway `CLAUDE.md` (principal stamping)
  - `request-origin/CLAUDE.md` (the agent gate stays separate, folds into the principal in Hosted)
  - an ADR addendum note: socket requests now carry a principal

## Verification

- `./equin test gateway`, plus Go `go test ./...` in `gateway/`. The table covers: cross-site, same-site sibling, `Origin: null`, rebinding Host, local tool, `none`, the old-browser Origin match, and header stripping.
- `./equin test plugins/framework/plugins/principal plugins/infra/plugins/endpoints plugins/framework/plugins/server-core`.
- `./equin build`. The app must still work: live state, writes, OAuth connect.
- **Probe** `plugins/framework/plugins/principal/e2e/cross-site-probe.ts`:
  - **Header leg:** for every route in both hosts' tables (`:params` filled with a sentinel), send a request with `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site`. Expect 403 `cross-site-refused` for owner routes; public routes are listed. The gate runs before the handler, so no side effects.
  - **Also in the header leg:** `/gateway/worktrees/x/restart`, the WS upgrade, and a rebinding Host.
  - **Browser leg:** Chromium on an attacker page served from `127.0.0.1:<port>`. It sends a `fetch` POST (no-cors), a form POST to install and a `WebSocket`. Statuses are seen via Playwright network events and must be refused. A same-origin control on the build must succeed.
  - This also records which Fetch Metadata Chromium sends to `http://*.localhost`.
- Re-run F9's curl: 403, not the handler's 404.
