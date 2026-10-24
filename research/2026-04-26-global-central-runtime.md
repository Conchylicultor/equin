# Central Runtime — design plan

## Context

State that is logically global to the user — OAuth tokens, encrypted secrets, OAuth client credentials — is today *replicated* across every worktree backend with hand-rolled sync:

- Each worktree runs the `auth` and `secrets` plugins. Reads RPC over `~/.singularity/auth.sock` and `~/.singularity/secrets.sock` to main; writes from worktrees go the same way (`plugins/auth/server/internal/unix-rpc/client.ts:23-41`, `plugins/secrets/server/internal/unix-rpc/client.ts:29-45`).
- After every mutation on main, `fanoutInvalidate()` (`plugins/auth/server/internal/fanout.ts:13-39`) walks `~/.singularity/worktrees/*.json`, POSTs `/api/auth/invalidate` to every worktree, and each worktree's handler clears its in-process caches and calls `authStateResource.notify()` to push updated state to its own browser tabs.

The leakage *is* the bug. A worktree's backend has no business enumerating other worktrees, every plugin that touches global state has to invent its own fanout, and forgetting one mutation site silently produces stale-UI bugs across worktrees. The fix is structural: move global state out of every worktree and into a single backend that the gateway routes to.

We are introducing a new plugin runtime peer of `web` / `server` / `shared`, named `central`. A central plugin's HTTP and WebSocket routes are served by exactly one Bun process (gateway-supervised, reserved name `central`). The gateway is taught a path-prefix routing manifest so that selected paths from any subdomain forward to the central backend, replacing the existing OAuth bare-localhost rewrite (`gateway/proxy.go:39-47`) with a generic mechanism.

After the migration: no unix sockets, no fanout, no `~/.singularity/worktrees/*.json` enumeration in plugins, no per-worktree caches of global state, no `isMain()` branches inside `auth` / `secrets`. Restarting `singularity.localhost` no longer kills auth.

## Current state — concrete pain points

- **Unix sockets duplicate HTTP.** `auth.sock` exposes `/token`, `/status`, `/disconnect`, `/api-key` (`plugins/auth/server/internal/unix-rpc/protocol.ts:62-67`); `secrets.sock` exposes `/get`, `/set`, `/delete`, `/has`, `/meta`, `/list` (`plugins/secrets/server/internal/unix-rpc/protocol.ts:3-10`). They are HTTP-over-UDS — same content as REST routes would be.
- **Two `isMain()` checks copy-pasted.** `plugins/auth/server/internal/paths.ts:11-13`, `plugins/secrets/server/internal/paths.ts:15-19`.
- **Fanout is fragile.** Synchronous `readdirSync` on the hot path (`fanout.ts:30-39`); errors swallowed; unrelated to mutations into the secrets store (writing a config secret on a worktree refreshes nothing).
- **OAuth rewrite is special-cased in Go.** Two hard-coded prefixes and a hard-coded backend name in `gateway/proxy.go:39-47`. Generalizing this is the same mechanism we need anyway.
- **Cross-process pushes already work — through the fanout.** `authStateResource` (`plugins/auth/server/internal/auth-resource.ts:7-21`) is `mode: "push"` and notifies subscribers on its own process; the fanout exists solely because subscribers live in *other* processes. A direct WS from browser to central removes this.

## Proposed architecture

### Topology

```
                ┌─────────────────────────────────────────────┐
   browsers ───►│   gateway  (Go, :9000)                       │
                │   • static fileserve per worktree            │
                │   • subdomain routing (foo.localhost → fooBE)│
                │   • routing manifest → central               │
                └──┬──────────────────────────┬────────────────┘
                   │                          │
        ┌──────────▼──────────┐    ┌──────────▼──────────────┐
        │ worktree backends   │    │ central backend         │
        │  (per worktree,     │    │  (singleton, reserved)  │
        │   web + server      │    │  • auth                 │
        │   plugins)          │    │  • secrets              │
        └─────────────────────┘    │  • central plugins…     │
                                   └─────────────────────────┘
```

- **`central`** is a reserved name in the gateway's worktree registry. The gateway supervises it with the same `Idle → Starting → Running → Stopping` state machine as any worktree backend (`gateway/worktree.go:127-217`), reuses the existing port pool, readiness TCP-dial, and idle sweep. It has no `web/dist` (no UI of its own) and is unreachable as a subdomain (`central.localhost` returns 404).
- **Worktree backends are unaware of central.** They simply do not register `auth` / `secrets` routes. Browsers and worktree backends talk to central via plain HTTP and WebSocket through the gateway. From a worktree backend's POV, the `/api/auth/*` routes simply don't exist locally — they're not its problem.
- **All HTTP via the gateway.** Unix sockets are deleted. Backend-to-backend reads (e.g. a future plugin needing `getAccessToken` on a worktree) are HTTP `fetch("http://localhost:9000/api/auth/token", …)`. Localhost is the trust boundary — same as today (any localhost process can already reach the gateway).

### Routing manifest

The gateway gains a *static manifest file* generated by `./equin build`:

- **Path:** `~/.singularity/central-routes.json`
- **Schema:**
  ```json
  {
    "backend": "central",
    "routes": [
      "/api/auth/",
      "/api/secrets/",
      "/ws/auth-state"
    ]
  }
  ```
- **How it gets there.** `./equin build` (`cli/src/commands/build.ts`) scans every plugin's `central/index.ts` barrel, collects `httpRoutes` / `wsRoutes` / `resources`, normalizes path prefixes, and writes the manifest atomically. This piggybacks on existing build steps (the docgen scan in `cli/src/docgen.ts:440-524` already enumerates plugin routes).
- **How the gateway reads it.** `gateway/registry.go` already uses `fsnotify` to watch `~/.singularity/worktrees/`. We add a sibling watcher for `central-routes.json`. On change, `Proxy` rebuilds an in-memory prefix tree.
- **Routing decision.** In `Proxy.ServeHTTP` (`gateway/proxy.go:26`), after `/gateway/*` interception and *before* per-host worktree resolution, we check the manifest's prefix tree. A match forwards to `central`'s backend regardless of subdomain (including bare `localhost:9000`). The current OAuth bare-localhost block at `gateway/proxy.go:39-47` is deleted — it becomes one entry in the manifest.

The manifest file is regenerated by `./equin build`, written atomically, and watched on disk. There is **no** runtime registration over `/gateway/*`. The dev path is: edit a central plugin → `./equin build` → routes update live.

### Browser → central WebSocket

Browsers maintain *two* WebSocket connections after this change:

1. The existing `/ws/notifications` to their own worktree's backend (per-worktree resources: tasks, conversations, etc.).
2. A new connection — also at `/ws/notifications`, but routed to central via the manifest — for central-defined resources (`auth-state`, future central resources).

The leader-elected `NotificationsClient` referenced in `plugin-core/CLAUDE.md` is extended to maintain a small set of WS connections, one per "resource origin." A resource carries an origin tag derived from the runtime that defines it: resources defined by central plugins are tagged `central`. The client subscribes to the right WS automatically; plugins continue to consume `useResource(authStateResource)` exactly as today.

The WS endpoint on central is the gateway path `/ws/notifications` *with the host stripped of any worktree subdomain* — i.e. the manifest routes `/ws/notifications` to central only when initiated against bare `localhost` or a special "central origin". Concretely we add a stable URL the client knows to dial: `/ws/central-notifications`. Central's server registers `wsRoutes: { "/ws/central-notifications": notificationsHandler }`; the manifest routes `/ws/central-notifications` to `central`. This keeps `/ws/notifications` per-worktree behavior untouched, avoiding any host-aware logic in the gateway.

### What moves to central

- **`plugins/auth/server/` → `plugins/auth/central/`.** All routes (`/api/auth/start/:provider`, `/api/auth/callback/:provider`, `/api/auth/state`, `/api/auth/disconnect`, `/api/auth/api-key`, `/api/auth/token`), the in-memory token store, refresh loop, credentials cache, `authStateResource`, all sub-plugin descriptors.
- **`plugins/auth/plugins/google/server/` → `plugins/auth/plugins/google/central/`.** Same for `notion`. Each provider sub-plugin's `registerAuthProvider` call moves with it.
- **`plugins/secrets/server/` → `plugins/secrets/central/`.** AES-GCM file I/O, keychain master key, all CRUD routes.
- **`plugins/config/server/` stays on the worktree** — per-worktree DB is its primary state. The two call sites that reach into secrets (`plugins/config/server/internal/handlers.ts:60-98`, `plugins/config/server/internal/secrets-resource.ts:34-41`) become HTTP calls: `fetch("http://localhost:9000/api/secrets/...")`. The secret-fields machinery in `config` becomes a thin client of central.

### What gets deleted

- `plugins/auth/server/internal/fanout.ts` (entire file)
- `plugins/auth/server/internal/handlers/invalidate.ts` and the `POST /api/auth/invalidate` route registration
- `plugins/auth/server/internal/unix-rpc/` (server + client + protocol)
- `plugins/secrets/server/internal/unix-rpc/` (server + client + protocol)
- All `isMain()` paths and dual-mode branches in `plugins/auth/server/internal/auth-state.ts`, `token-access.ts`, `token-store.ts`, `boot.ts`
- `AuthMainOfflineError`, `SecretsMainOfflineError` and the call sites that catch them — replaced by HTTP 503 from the gateway when `central` is unreachable; loaders surface `mainOffline: true` from a single network-failure code path.
- The synthetic `authStateResource` loader fork (worktree branch calls `rpcStatus`, main branch calls `computeAuthState`) — central's loader always calls `computeAuthState` since central *is* main for these purposes.
- The `~/.singularity/worktrees/*.json` enumeration in plugin code. Plugins never need to know about other worktrees.

## Plugin-system changes (plugin-core, linter, build)

### Path aliases / tsconfig

- **New** `central/tsconfig.json` mirroring `server/tsconfig.json`, with `include` covering `../plugins/*/central` and `../plugins/*/shared`, plus the same nested-plugin glob expansion (depth 4).
- **`server/tsconfig.json`** — leave unchanged. The server runtime cannot see `central` source.
- **`web/tsconfig.app.json`** — leave unchanged. Web cannot see `central` source either; types come from `shared` only.
- **`web/vite.config.ts`** — no change; `@plugins` is a directory alias.

### Linter (`cli/src/checks/plugin-boundaries.ts`)

- `VALID_RUNTIMES` (line 20): add `"central"`.
- `FRAMEWORK_FILES` (line 14): add `"central/src/plugins.ts"` and `"central/src/index.ts"`.
- Barrel-purity loop (line 79): add `"central"` to the iterated runtime list.
- `runtimeForPath` (line 200): recognize `central/` segment.
- Cycle detection (lines 138-145): add a `centralEdges` partition. Edges with `runtime ∈ {"central","shared"}` go in `centralEdges`. Web and server graphs stay as today. A cycle within `central+shared` is independent and is checked separately.
- `cli/src/checks/no-plugin-imports-in-core.ts` (`COMPOSITION_ROOTS`, line 17): add `"central/src/plugins.ts"`.
- `SOURCE_ROOTS` for the import-walk: add `"central/src"`.

### Cross-runtime grammar

`@plugins/<x>/shared` remains the only cross-runtime barrel. Imports of `@plugins/<x>/central` from a non-central source plugin fail at the *tsconfig include* layer (web's and server's tsconfigs do not include `central/`), giving a clean "module not found" error. We do **not** add an extra linter rule — tsconfig already encodes the boundary.

### `central/` runtime files (new)

- `central/package.json` — `@singularity/central`, depends on `@singularity/server` for shared types (or we factor shared types out — see below).
- `central/src/index.ts` — entry point. Mirrors `server/src/index.ts:1-30`: read `PORT` from env, `Bun.serve()`, flatten `httpRoutes` / `wsRoutes` / `resources` from imported central plugins, run `onReady` hooks. No DB migrations (central does not own a Postgres DB).
- `central/src/plugins.ts` — registry list (peer of `server/src/plugins.ts`).
- `central/src/types.ts` — `CentralPluginDefinition = ServerPluginDefinition`. Same shape (httpRoutes, wsRoutes, resources, onReady, onShutdown). The shape is reused; only the registration list differs.
- `central/src/resources.ts` — central-side copy of the resource registry, identical to `server/src/resources.ts`. Or factor into `@singularity/server-runtime` shared package. Defer the factoring to phase 2 if mechanical; for v1 a small duplication is acceptable.

### Docgen (`cli/src/docgen.ts`)

- `collectPlugin` (lines 440-524): also read `central/index.ts` and produce `centralExports`, `centralRoutes`, `centralResources`.
- `renderPlugin`: add a `renderExports("central", …)` block.
- `findAllPluginDirs`: recognize `central/index.ts` as a plugin-presence signal so plugins that are central-only still appear in `docs/plugins.md`.

### Build (`cli/src/commands/build.ts`)

- After `bunx tsc` in `server/`, also run `bunx tsc` in `central/`.
- After docgen, walk central plugins and write `~/.singularity/central-routes.json` atomically (`.tmp-<uuid>` + rename).
- After `~/.singularity/worktrees/<name>.json` is written, also write `~/.singularity/worktrees/central.json` if missing — pointing at `<repo-root>/central` for `server` and an empty/sentinel directory for `web`. The gateway will spawn it on first request via the manifest. (The `web` field is required by the registry schema today; we either point it at an empty stub or extend the schema with `web?: string`.)

## Gateway changes

### `gateway/proxy.go`

- **Delete** the OAuth bare-localhost block at lines 39-47. It is replaced by a manifest entry.
- **Add** a manifest lookup early in `ServeHTTP`:
  ```go
  if backend := p.routes.Lookup(r.URL.Path); backend != "" {
      worktreeName = backend  // forward to central regardless of host
  } else if worktreeName == "" {
      // remaining bare-localhost paths still 404
      http.Error(w, "Singularity gateway. Use <name>.localhost.", http.StatusNotFound)
      return
  }
  ```
- The manifest's prefix tree is owned by `Proxy` and rebuilt atomically when `central-routes.json` changes.

### `gateway/registry.go`

- Add a second fsnotify watcher for `~/.singularity/central-routes.json`. On change, parse and swap the manifest pointer on `Proxy`.
- Reserve the name `central` from the worktree-name validation regex (or rather: the gateway accepts `central` as just another worktree name; *the build pipeline* refuses to register a worktree named `central` for normal worktrees).

### `gateway/main.go`

No changes beyond wiring the new watcher.

### What stays the same

- The lazy-spawn / readiness / idle sweep / port pool model is reused unchanged. Central is supervised exactly like a worktree.
- Static file serving is per-worktree as today; central serves no statics.
- `/gateway/*` API is unchanged.

## Migration

Data on disk does **not** move:

- `~/.singularity/secrets.json.enc` and the OS-keychain master key (or fallback `~/.singularity/secrets/.key`) stay where they are. Central reads them at the same paths main reads them today.
- The `auth-tokens/blob-v1` namespace key in the secrets store is unchanged.
- The legacy migration in `plugins/secrets/server/internal/migrate-auth-tokens.ts` carries over with the central migration; it is idempotent and harmless if the migration has already run.
- The Postgres `singularity` DB used by main is *not* used by central. Central is stateless on Postgres.

The unix sockets (`~/.singularity/auth.sock`, `~/.singularity/secrets.sock`) are removed; users do not need to do anything — the files are recreated by the old code each boot, never read by the new code, and can be left to be reaped by OS cleanup or trivially `rm`ed.

OAuth client config registered with Google continues to use redirect URI `http://localhost:9000/api/auth/callback/google`. The gateway still listens on `:9000`; the manifest routes that path to central. No change to Google Cloud Console.

## Phased rollout

1. **Phase 1 — central runtime infrastructure.** Add `central/` runtime, linter rules, tsconfig, docgen support, build pipeline. Add gateway routing manifest reading (with an empty manifest, no behavior change). Land as plumbing only — no plugins migrated. The OAuth bare-localhost block stays for now.
2. **Phase 2 — migrate `secrets`.** Move `plugins/secrets/server/` → `plugins/secrets/central/`. Add `/api/secrets/*` HTTP routes (replacing the unix socket). Update `plugins/config/server/` to call those routes via fetch. Remove the unix-socket implementation. Verify settings-secret-fields work in any worktree.
3. **Phase 3 — migrate `auth` (and provider sub-plugins).** Move `plugins/auth/server/` and `plugins/auth/plugins/{google,notion}/server/` to `central/`. Add the routing manifest entries (`/api/auth/`, `/ws/central-notifications`). Delete the OAuth bare-localhost block from `gateway/proxy.go`. Delete the fanout, the invalidate handler, and the unix socket. Extend the browser `NotificationsClient` to dial `/ws/central-notifications` and route central-tagged resources to it. Verify Google OAuth and Notion smoke flows. Verify token persists across `singularity` worktree restart.
4. **Phase 4 — cleanup.** Remove `AuthMainOfflineError`/`SecretsMainOfflineError` and their callers (replaced by 503 from the gateway). Remove duplicate `isMain()` paths.

Each phase is independently shippable and reversible. After Phase 3, the leakage is gone.

## Risks

- **Browser `NotificationsClient` extension is the most invasive client-side change.** Extending it to multiplex over multiple WS endpoints with leader election per endpoint is fiddly. Mitigation: the existing implementation already supports per-key leader election; we extend the key to include the origin tag. Test multi-tab behavior explicitly.
- **Resource origin discovery.** The web side must know which resources live on central. We carry an `origin: "central"` field in the resource descriptor (the `shared/` barrel) so the client routes WS subscriptions correctly. Auth's `authStateResource` shared descriptor (`plugins/auth/shared/resources.ts`) gains this field; future central resources do likewise.
- **Boot-order dependency.** A worktree backend that calls central during its own `onReady` will face a cold-start race. Mitigation: gateway's lazy-spawn already serializes — the first `fetch` blocks until central is ready. We should still document that worktree-side `onReady` should not synchronously depend on central; resources defer their first load until subscription.
- **Localhost trust boundary.** Today `chmod 0600` on the unix socket gates secret reads; tomorrow any localhost process can `curl http://localhost:9000/api/secrets/get`. This is unchanged from the *currently-already-exposed* `getAccessToken` HTTP path on every worktree, but it widens the surface for raw secret CRUD. Mitigation: this matches our existing trust model (we already trust localhost). If we want stricter scoping later, we can add a header-based shared secret between worktree backends and central, generated by the gateway and injected into the proxy chain — deferred.
- **Manifest staleness during dev.** Editing a central plugin's routes requires `./equin build` to regenerate the manifest. The fsnotify watcher picks it up live; no gateway restart needed.
- **`central.json` worktree registry shape.** The `web` field is required (`gateway/registry.go:214-218`). Either we point central's `web` at an empty directory (so accidental hits to `central.localhost` 404 from missing `index.html`) or extend the spec to allow `web` to be omitted. Prefer the schema extension — one Go field made optional, plus a registry validation tweak.

## Critical files

- `gateway/proxy.go` — delete `:39-47`, add manifest lookup in `ServeHTTP`
- `gateway/registry.go` — add second fsnotify watcher
- `gateway/worktree.go` / `Spec` — make `web` optional
- `cli/src/commands/build.ts` — emit `~/.singularity/central-routes.json`; run `bunx tsc` in `central/`
- `cli/src/checks/plugin-boundaries.ts` — `VALID_RUNTIMES`, `FRAMEWORK_FILES`, barrel loop, `runtimeForPath`, cycle partitions
- `cli/src/checks/no-plugin-imports-in-core.ts` — `COMPOSITION_ROOTS`
- `cli/src/docgen.ts` — read `central/index.ts`, render central exports/routes/resources
- `central/{package.json,tsconfig.json,src/{index.ts,plugins.ts,types.ts,resources.ts}}` — new
- `web/tsconfig.app.json`, `server/tsconfig.json` — unchanged
- `plugins/auth/server/` → `plugins/auth/central/` (incl. provider sub-plugins)
- `plugins/secrets/server/` → `plugins/secrets/central/`
- `plugins/auth/shared/resources.ts` — add `origin: "central"` to `authStateResource` descriptor
- `plugin-core/notifications client` — extend to multiplex by origin
- Delete: `plugins/auth/server/internal/fanout.ts`, `plugins/auth/server/internal/handlers/invalidate.ts`, both `unix-rpc/` directories

## Verification

End-to-end manual smoke:

1. `./equin build` from a fresh checkout. Confirm `~/.singularity/central-routes.json` is written and the gateway logs picking it up.
2. Connect Google in `singularity.localhost:9000` Accounts pane. Confirm popup, OAuth callback, and Accounts UI updates.
3. Create a worktree (`./equin build` from a worktree clone). Open `<wt>.localhost:9000`. Confirm the Accounts pane shows the same connected state — without any HTTP `invalidate` fanout having fired (verify by absence in gateway logs).
4. Disconnect Google in worktree A. Confirm worktree B's UI updates within ~1 s — pushed live from central via `/ws/central-notifications`.
5. Restart `singularity` worktree's backend (`POST /gateway/worktrees/singularity/restart`). Confirm auth state is preserved in worktree B (central did not restart).
6. Restart central (`POST /gateway/worktrees/central/restart`). Confirm auth state is preserved (data on disk) and UIs reconnect within readiness timeout.
7. Set a config secret in worktree A (e.g. Google `clientSecret`). Confirm worktree B sees the credentials-configured state update without restart.
8. `./equin check --plugin-boundaries` passes; `./equin check --plugins-doc-in-sync` passes (`docs/plugins.md` shows the new `central` exports per migrated plugin).
9. Grep for `~/.singularity/worktrees/*.json` enumeration in plugins — only the gateway should reference it.
10. Grep for `isMain()` in `plugins/auth/` and `plugins/secrets/` — zero hits after Phase 3.
