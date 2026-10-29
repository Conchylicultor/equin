# principal

Who a request is. A **principal** is the edge's verdict on the caller:
`owner` (the person this instance belongs to), `anonymous` (anyone else), or
`content` (a request on the content host, `<item>.content.localhost` —
untrusted content served off every app origin; never the owner).
Hosted widens it later (a device, an agent, a share link). Design:
[`research/2026-10-28-global-http-edge-principal.md`](../../../../research/2026-10-28-global-http-edge-principal.md);
the Trust boundaries track (Phase 1) and the single-instance ADR
([`research/2026-07-02-global-adr-single-instance-per-user.md`](../../../../research/2026-07-02-global-adr-single-instance-per-user.md)).

## The rule lives in the gateway

The gateway (`gateway/principal.go`, see [`gateway/CLAUDE.md`](../../../../gateway/CLAUDE.md)
→ Principal) decides it once per request — same-origin, not same-site: a
non-equin Host (DNS rebinding) is anonymous; `Sec-Fetch-Site: same-origin` /
`none` is the owner; no `Sec-Fetch-Site` and no `Origin` is a local tool (the
CLI, MCP, a script), the owner; everything else (another site, a sibling
namespace, `Origin: null`) is anonymous. It deletes any client-sent
`X-Equin-Principal` and stamps its own on every proxied request, HTTP and
WebSocket. It refuses two things itself: an anonymous non-GET `/gateway/*` call
and every anonymous WebSocket upgrade.

The backends never re-derive it. `principalOf(req)` (core) reads the stamp,
**fail closed**: exactly `owner` is the owner, anything else — a missing header
included — is anonymous. `PRINCIPAL_HEADER` is pinned to the Go constant by the
`principal:header-in-sync` check.

## Every route is owner-only unless it says why not

```typescript
export const oauthCallback = defineEndpoint({
  route: "GET /api/auth/callback/:provider",
  access: { public: "authenticated by the OAuth state nonce an owner request minted" },
});
```

- `EndpointAccess = "owner" | { public: string } | { content: string; item: string }`.
  A declaration spells `access: { public: "<reason>" }` or (a GET only)
  `access: { content: "<reason>", item: "<param>" }` (`infra/endpoints`); its
  absence is `"owner"`, which has no spelling — so a forgotten field is the
  safe answer, and an empty reason throws at declaration.
- A **content** route is served only to the `content` principal: asked for on
  an app origin it answers `403 { reason: "content-only" }` (its document would
  run as the owner there), anyone else `403 cross-site-refused`. Every other
  route refuses `content` like `anonymous`. See `primitives/embed/frame`
  (Trust boundaries, Phase 3).
- The rule is the same for every method: an anonymous caller reaches public
  routes only — GETs, writes and WebSocket upgrades alike (no socket is
  public). SPA pages are static (served by the gateway), so a pasted app link
  still loads.
- `implement` / `implementMachine` / `rawEndpointHandler` / `machineHandler`
  attach the resolved `access` to the handler they build
  (`EndpointHttpHandler.access`, server-core). A handler not built by
  endpoints (a core-owned route, a plain central handler) has none: owner. A
  public route must therefore be served through one of them — a raw HTML /
  redirect route through `rawEndpointHandler(decl, handler)`.

## The handshake: enforced only when the gateway says it stamps

Fail-closed on a missing header is only safe behind a gateway that stamps one.
The gateway binary is a shared dependency `./equin build` neither rebuilds nor
restarts, so a freshly built backend can boot behind an older gateway — which
sends no header, so a fail-closed host would refuse everything, the gateway's
own readiness probe included ("backend spawn failed: readiness timeout"), and
take down main and every worktree until someone restarted it.

So the gateway **declares** it: every backend's argv ends with the bare
`--principal-stamped` (`backendLaunch`, `gateway/worktree.go`; central is
spawned the same way). `readPrincipalStamp(argv)` (`core/stamp.ts`) reads and
records it once, at bind; `principalStamp()` reads it back
(`stamped` / `unstamped` / `undeclared` — an exec child, a CLI, a test).

- **Stamped** — the gate below.
- **Not stamped** — every route served ungated (every caller is the owner, the
  pre-principal status quo), loudly but not fatally: a `console.error` at boot
  (`UNSTAMPED_GATEWAY_WARNING`), the route table answers `stamped: false`, the
  health report's **Gateway** row (`infra/launcher/gateway-drift`) lists "does
  not stamp the principal" as a difference, and the cross-site probe fails
  with "gateway not stamping".

**The protection takes effect only once the gateway is restarted:
`./equin start --force`.** `principal:header-in-sync` pins the Go flag
(`principalStampedFlag`) to `PRINCIPAL_STAMPED_FLAG` as well as the header.

## Where it is enforced

- **The two socket hosts** — server-core's and central-core's `bin/index.ts` —
  build their gate with `hostGateFromArgv(process.argv)` (the handshake above)
  and hand their router `gate.routes({ tableRoute, http, wsPaths })`:
  `gateByPrincipal` decides per route, once, at registration — a public route
  passes through untouched, any other answers an anonymous request
  `403 { reason: "cross-site-refused", route, message }` (the gateway's own
  body, word for word) before its handler runs, so before any side effect.
  Before `server.upgrade`, `gate.refuseUpgrade` refuses an anonymous
  WebSocket — the host's floor beneath the gateway's refusal.
- **Not the in-realm browser host** (`server-core/core/browser-host.ts`): its
  only caller is the page itself.
- **Each socket host serves its route table**, owner-only:
  `GET /api/host/routes` (server-core) and `GET /api/central/host/routes`
  (central — its own path, so the central-routes manifest sends it there) answer
  `{ stamped, routes: [{ route, kind: "http" | "ws", access: "owner" | "public", reason? }] }`
  (`HostRouteTableSchema`). The cross-site probe enumerates it.
- **No handler reads `Origin` / `Sec-Fetch-*` itself** — the
  `principal/no-origin-header-read` lint. host-fs's per-route `isAppOrigin`
  was such a second answer (three routes had it, every other had nothing).
  The one narrower question left — "did any browser send this, the owner's own
  page included?" — is `isBrowserRequest(req)` here (deploy secrets' approved
  env is read only by the CLI).

## Not here yet

- The agent-write gate (`infra/request-origin`, `endpoints`' `agentWrite`) is a
  separate axis — *which* owner-side actor wrote — and stays separate for now;
  it folds into the principal in Hosted (an agent becomes a principal).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Who a request is: the principal (owner | anonymous) the gateway stamps on every proxied request (X-Equin-Principal), read fail-closed by principalOf; EndpointAccess (owner by default, { public: reason } opt-in); gateByPrincipal — the socket hosts' per-route gate, on only when the gateway declares it stamps (--principal-stamped on the backend's argv; ungated and loudly so behind an older gateway), answering an anonymous caller of an owner route 403 cross-site-refused before the handler runs — the anonymous WebSocket refusal, and each host's route table. Plus the Go↔TS header sync check and the lint rule that keeps origin / Sec-Fetch-* reads out of handlers.
- Core:
  - Exports (types):
    - `EndpointAccess`
    - `GatedRouteHandler`
    - `HostGate`
    - `HostRoute`
    - `HostRouteTable`
    - `Principal`
    - `PrincipalStamp`
  - Exports (values):
    - `CENTRAL_HOST_ROUTES_ROUTE`
    - `CONTENT_ONLY_MESSAGE`
    - `contentOnlyResponse`
    - `CROSS_SITE_REFUSED_MESSAGE`
    - `crossSiteRefusedResponse`
    - `gateByPrincipal`
    - `HOST_ROUTES_ROUTE`
    - `hostGateFromArgv`
    - `HostRouteSchema`
    - `HostRouteTableSchema`
    - `isBrowserRequest`
    - `isCrossSiteRefusal`
    - `PRINCIPAL_HEADER`
    - `principalOf`
    - `principalStamp`
    - `UNSTAMPED_GATEWAY_WARNING`

<!-- AUTOGENERATED:END -->
