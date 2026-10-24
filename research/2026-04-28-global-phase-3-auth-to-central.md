# Phase 3 — migrate `auth` to central runtime

## Context

Phases 1 (central runtime + manifest) and 2 (secrets migration) are landed. Auth (and the Google/Notion provider sub-plugins) still runs *per worktree* with:

- A unix-socket RPC layer (`plugins/auth/server/internal/unix-rpc/`) that worktree backends use to read/write tokens on main.
- A fanout (`plugins/auth/server/internal/fanout.ts`) that walks `~/.singularity/worktrees/*.json` after every mutation and POSTs `/api/auth/invalidate` to each worktree backend so they refresh their per-process caches.
- Two duplicated `isMain()` checks (`paths.ts`, plus 12 call sites) gating which code path runs in which process.
- An OAuth bare-localhost block in `gateway/proxy.go` (lines 45-53) hard-coding `/api/auth/start/` and `/api/auth/callback/` to the `singularity` worktree, because Google rejects `*.localhost` redirect URIs.

After Phase 3: tokens live in a single central process, the OAuth callback works regardless of which worktree the user opened the popup from, all browser tabs (across worktrees) get auth-state pushes live via a single `/ws/central-notifications` WebSocket, and the auth plugin contains zero `isMain()` branches.

The migration follows the same shape as Phase 2's secrets move — but unlike secrets (which kept a thin worktree-side HTTP-client barrel because `config` calls `getSecret`), auth has **no external runtime consumers**, so `plugins/auth/server/` is deleted outright.

## Design

### What moves

```
plugins/auth/server/                          → plugins/auth/central/
plugins/auth/plugins/google/server/           → plugins/auth/plugins/google/central/
plugins/auth/plugins/notion/server/           → plugins/auth/plugins/notion/central/
```

The migrated content keeps its file structure. While moving:

1. **Drop every `isMain()` branch.** Central is always "main" for these purposes. 13 files affected (full list in *Critical files*). `paths.ts` shrinks to just path constants — `isMain()`, `WORKTREE_DIR`, `MAIN_WORKTREE_NAME`, `SOCKET_PATH` are deleted.
2. **Delete `fanout.ts`, `handlers/invalidate.ts`, `unix-rpc/`.** The route registration for `POST /api/auth/invalidate` goes with it. `actions.ts` drops three `fanoutInvalidate()` call sites and just calls the local `authStateResource.notify()` — central's WS push reaches every browser tab directly.
3. **Rewrite `auth-resource.ts`.** It currently forks the loader on `isMain()` (worktree branch RPCs over the unix socket; main branch calls `computeAuthState`). Central just calls `computeAuthState`.
4. **`registerAuthProvider` keeps its current shape** but is now imported by sub-plugin `central/internal/register.ts` files instead of `server/internal/register.ts`. The provider registry lives in central's process and is the only one.

### Worktree side: nothing left

- `plugins/auth/server/` is deleted in full. No worktree backend ships any auth code.
- `plugins/auth/plugins/google/server/` and `.../notion/server/` are deleted in full. The provider sub-plugins keep `web/`, `shared/`, and gain `central/`.
- `plugins/auth/web/` is unchanged. It already POSTs to `/api/auth/*` on the gateway — those paths now route to central via the manifest.

### Central runtime registration

`central/src/plugins.ts` adds three imports:

```ts
import authPlugin from "@plugins/auth/central";
import googleAuthPlugin from "@plugins/auth/plugins/google/central";
import notionAuthPlugin from "@plugins/auth/plugins/notion/central";
```

### Resource origin tagging — separate factory

Add a new factory in `plugins/primitives/plugins/live-state/shared/resource.ts`:

```ts
export function centralResourceDescriptor<T, P extends Record<string, string> = Record<string, never>>(
  key: string,
): ResourceDescriptor<T, P> {
  return { key, origin: "central" };
}
```

`ResourceDescriptor` gains a single optional field `origin?: "central"`. Default (omitted) means worktree-origin. `resourceDescriptor()` is unchanged — existing call sites (`tasks-core`, `crashes`, `config`, etc.) need no edits.

`plugins/auth/shared/resources.ts` switches:

```ts
// before
export const authStateResource = resourceDescriptor<AuthStateValue>("auth-state");
// after
export const authStateResource = centralResourceDescriptor<AuthStateValue>("auth-state");
```

### NotificationsClient multiplexing

`plugins/primitives/plugins/live-state/web/notifications-client.ts` is extended to maintain **two** `SharedWebSocket` instances keyed by origin: `worktree` (URL `/ws/notifications`) and `central` (URL `/ws/central-notifications`). On `observe(descriptor, …)`, the client looks at `descriptor.origin` and routes the subscription to the correct socket. Replay-on-reconnect is per-socket. Leader election (Web Locks + BroadcastChannel inside `SharedWebSocket`) keeps working unchanged — it's per-URL, so the two sockets elect leaders independently.

`useResource`'s HTTP fallback (used when WS is unavailable) is similarly extended: central-origin descriptors fetch from `/api/central-resources/${key}` instead of `/api/resources/${key}`. This keeps the per-worktree resource URL space distinct from central's so the gateway manifest match is unambiguous.

### Central WS + HTTP fallback handlers

Registered as runtime-level routes in `central/src/index.ts` (peer of `server/src/index.ts:125`):

- `wsRoutes["/ws/central-notifications"] = notificationsWsHandler` — reuses central's existing copy of `notificationsWsHandler` from `central/src/resources.ts`.
- `httpRoutes["/api/central-resources/:key"] = resourcesHttpHandler` — central-side analog of the worktree's `/api/resources/:key`. Both implementations already exist in `central/src/resources.ts` (duplicated from `server/src/resources.ts` per Phase 1's "small duplication is acceptable" decision).

### Gateway changes

**`gateway/proxy.go` lines 45-53** — delete the OAuth bare-localhost block in full. After deletion, bare-localhost paths that don't match the manifest fall through to the existing 404. The `/api/auth/start/` and `/api/auth/callback/` paths reach central via the manifest entry below (they match `/api/auth/`), regardless of host.

No other gateway changes. `gateway/registry.go` and `gateway/central_routes.go` already watch `~/.singularity/central-routes.json` and rebuild the prefix tree atomically.

### Manifest entries

`cli/src/commands/build.ts:25-37` (`collectCentralRoutes`) auto-collects from each central plugin's `httpRoutes`/`wsRoutes`. After moving auth, the manifest gains:

- `/api/auth/` (prefix — covers `/api/auth/start/:provider`, `/api/auth/callback/:provider`, `/api/auth/state`, `/api/auth/disconnect/:provider`, `/api/auth/api-key/:provider`)

Two additional baseline entries are runtime-level (not plugin contributions), so they are hard-coded in `build.ts` alongside the auto-collection step:

- `/ws/central-notifications`
- `/api/central-resources/`

### Cleanup

- Delete `plugins/auth/shared/internal/errors.ts`'s `AuthMainOfflineError` class and its export from `plugins/auth/shared/index.ts`. The unix-rpc client (its only emitter) is being deleted; the error becomes unreachable.
- `web/` does not currently reference `AuthMainOfflineError` (verified during exploration), so no web-side cleanup required for it.
- `SecretsMainOfflineError` is *not* touched — that's Phase 4's scope.

## Critical files

### New

- `plugins/auth/central/index.ts` — barrel (mirrors `plugins/infra/plugins/secrets/central/index.ts`)
- `plugins/auth/central/package.json`, `tsconfig.json` (mirror secrets)
- `plugins/auth/central/internal/` — populated by moving `plugins/auth/server/internal/*` minus deleted files
- `plugins/auth/plugins/google/central/{index.ts,package.json,tsconfig.json,internal/{register.ts,descriptor.ts}}`
- `plugins/auth/plugins/notion/central/{index.ts,package.json,tsconfig.json,internal/{register.ts,descriptor.ts}}`

### Modified

- `central/src/plugins.ts` — add three plugin imports
- `central/src/index.ts` — register `/ws/central-notifications` + `/api/central-resources/:key` runtime routes
- `cli/src/commands/build.ts` — emit baseline manifest entries for `/ws/central-notifications` and `/api/central-resources/`
- `gateway/proxy.go` — delete lines 45-53 (OAuth bare-localhost block)
- `plugins/primitives/plugins/live-state/shared/resource.ts` — add `origin?: "central"` to `ResourceDescriptor`, add `centralResourceDescriptor()` factory
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — multiplex two `SharedWebSocket`s by origin
- `plugins/primitives/plugins/live-state/web/use-resource.ts` — HTTP fallback URL switches on origin
- `plugins/auth/shared/resources.ts` — use `centralResourceDescriptor`
- `plugins/auth/shared/internal/errors.ts`, `shared/index.ts` — drop `AuthMainOfflineError`

### Files moved server→central with logic simplified (drop `isMain()` branches)

- `boot.ts`, `paths.ts`, `auth-resource.ts`, `auth-state.ts`, `token-store.ts`, `token-access.ts`, `actions.ts`, `credentials.ts`, `oauth-flow.ts`, `registry.ts`, `refresh-loop.ts`, `routes.ts`
- `handlers/oauth-start.ts` (drop worktree redirect logic), `handlers/oauth-callback.ts`, `handlers/state.ts`, `handlers/disconnect.ts`, `handlers/api-key.ts`

### Deleted

- `plugins/auth/server/` (entire directory, after moves)
- `plugins/auth/plugins/google/server/`, `plugins/auth/plugins/notion/server/` (entire directories)
- `plugins/auth/server/internal/fanout.ts`
- `plugins/auth/server/internal/handlers/invalidate.ts` + its registration in `routes.ts`
- `plugins/auth/server/internal/unix-rpc/` (3 files)

## Verification

End-to-end smoke (matches design doc §Verification):

1. `./equin build` from this worktree. Confirm `~/.singularity/central-routes.json` includes `/api/auth/`, `/ws/central-notifications`, `/api/central-resources/`. Confirm `bunx tsc` in `central/` passes with the moved code.
2. `./equin check --plugin-boundaries` and `./equin check --plugins-doc-in-sync` pass. `docs/plugins.md` shows auth/google/notion under their `central:` exports section.
3. From `singularity.localhost:9000`, open Accounts → Connect Google. Confirm OAuth popup, callback, and Accounts UI updates to "connected".
4. Open this worktree at `<wt>.localhost:9000`. Accounts pane shows the same connected state without any `/api/auth/invalidate` HTTP traffic (confirm via gateway logs).
5. Disconnect Google in worktree A. Confirm worktree B's UI updates within ~1 s, pushed through `/ws/central-notifications`.
6. Restart `singularity`'s backend (`POST /gateway/worktrees/singularity/restart`). Confirm worktree B's auth state stays live (central was not restarted).
7. `grep -rn "isMain\|fanoutInvalidate\|unix-rpc" plugins/auth/` returns zero hits.
8. `grep -rn "auth.sock\|AuthMainOfflineError" .` returns zero hits in `plugins/`, `web/`, `central/`.
9. Notion smoke: open Connect Notion, complete OAuth flow, confirm Accounts row updates.

## Risks

- **WS multiplexing.** `NotificationsClient` extension is the most invasive client-side change. Mitigation: leader election is per-URL inside `SharedWebSocket` already, so two instances are independent. Test multi-tab + worktree-switch explicitly in step 5.
- **Manifest collection of runtime-level routes.** `/ws/central-notifications` and `/api/central-resources/` are not declared by any plugin — the build script must emit them alongside the auto-collected plugin routes. Easy to forget; verify via step 1.
- **Boot-order race.** Worktree backends never call into central synchronously during their own `onReady` (verified — no current consumers). No mitigation needed; document constraint in `central/CLAUDE.md` if not already.
