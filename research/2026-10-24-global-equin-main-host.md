# Step 3 of the rename: the app hands out `equin.localhost`

Track page: *Rename equin to Equin* (block-dc049371-1f5f-413d-af7b-6e12b531d579).

## Context

Step 1 made `http://equin.localhost:9000` open the main app: a host alias
(`NAMESPACE_HOST_ALIASES` in `plugins/infra/plugins/namespace/core/namespace.ts`,
mirrored by `hostAliases` in `gateway/proxy.go`). Step 2 swept the old CLI name.
But every address the app itself *produces* for main is still
the old `singularity` host, because it derives from the namespace name
(`namespaceHost(ns)` = `${ns}.localhost:9000`, and main's namespace is
`singularity`).

Goal: everything people and agents are handed reads `http://equin.localhost:9000`.
The old host keeps working as a quiet alias, with no redirect. The namespace
itself stays `singularity`: its database, spec dir, socket, `--namespace` and
`~/.singularity/` are internal identifiers, and renaming them is the track's
separate, later decision.

### What the survey found

- **Almost every producer already goes through one function.** Build/deploy
  output (`cli/build/run.ts`, `deploy-namespace.ts`), `./equin start` /
  `serve-app` / `release` output, e2e target resolution
  (`e2e-harness/e2e/target.ts`), the agent browser target
  (`infra/mcp/browser/server/internal/target.ts`), agents' MCP URLs
  (`scratch-workspace.ts`, `compaction-context`), the Accounts pane `MAIN_URL`,
  the Studio compositions host column and prototype URLs all call
  `namespaceUrl` / `namespaceHost`. One change at the owner flips them all.
- **OAuth redirect URIs need no change.** They are bare
  `http://localhost:9000/api/auth/callback/<provider>` (`auth/central/internal/oauth-flow.ts`,
  `oauth-client-setup.tsx`, `google-setup.tsx`), so nothing registered with
  Google or Notion moves.
- **One latent bug turns into a regression.** The OAuth callback page posts its
  result to the opener with `targetOrigin = namespaceUrl(worktree)`
  (`auth/central/internal/handlers/oauth-callback.ts:144`). The opener sends
  only its namespace (`?worktree=singularity`), not the host it is on. So today
  a Connect started from `equin.localhost` has its completion message dropped by
  the browser. Once main's URL becomes `equin`, a Connect from the old host
  breaks the same way.
- **Hard-coded literals** (not derived): `LOCAL_APP_HOST` in
  `apps/website/plugins/shell/core/site.ts` (the download page), `install.sh`,
  `docs/setup.md`, root `CLAUDE.md` (Ports, prototypes), `prototypes/CLAUDE.md`,
  `e2e-harness/CLAUDE.md`, the `--url` example in e2e
  script headers, about 63 research docs, and test fixtures.
- **Per-origin browser state.** None of it is load-bearing. Tabs live in
  `sessionStorage` and die with the tab anyway. In `localStorage` there are
  prompt drafts (already copied by hand), column widths, chosen views, list
  view states, section folds, per-conversation pane layouts, usage orders,
  action-bar position, map camera and the sidebar cookie. The user can carry
  this over by hand (see *Manual state copy*), so no migration code is written.

## Design

### 1. The namespace owner learns each namespace's *public host label*

In `namespace/core/namespace.ts`, flip the alias table so it says which label a
namespace is **handed out** under, and derive the alias set from that:

```ts
/** The host label a namespace is handed out under, when it is not its own name. */
export const NAMESPACE_HOST_LABELS: Readonly<Partial<Record<Namespace, string>>> = {
  [MAIN_WORKTREE_NAME]: "equin",
};
/** Derived: host label → namespace (what `namespaceFromHost` and the gateway resolve). */
export const NAMESPACE_HOST_ALIASES = invert(NAMESPACE_HOST_LABELS);
```

- `namespaceHost(ns)` writes `NAMESPACE_HOST_LABELS[ns] ?? ns`, so main becomes
  `equin.localhost:9000` and every other namespace is unchanged.
- `namespaceFromHost` is unchanged. It accepts both `equin.localhost` (alias →
  `singularity`) and the namespace's own name as a host (now the
  legacy spelling). The round-trip `namespaceFromHost(namespaceHost(ns)) === ns`
  still holds.
- `namespaceCollision` and the `namespace:grammar-in-sync` check keep reading
  `NAMESPACE_HOST_ALIASES`, which is now derived, so nothing else changes. The
  gateway's `hostAliases` stays `"equin": "singularity"`.
- Because a public label is one table, there is no second place that can
  disagree about "what is main's address". This is rung 1 of the fix ladder: a
  hand-built `equin.localhost` has no reason to exist.
- Update the module and plugin CLAUDE.md wording ("alias kept for the old host"
  becomes "public label; the namespace name stays accepted").

Server-to-server callers that use `namespaceUrl` as a fetch origin (deploy
probes, boot-bench, sentinel fleet flights, `db fork`) now dial
`equin.localhost`. The gateway maps it to the same backend before anything
looks it up, so the only change is the Host header.

### 2. OAuth completion posts to the opener's real origin

- `auth/web/connect.ts`: also send `origin=window.location.origin`.
- `oauth-start.ts`: validate it. It must parse as a URL, and
  `namespaceFromHost(url.host)` must equal the `worktree` param. Otherwise
  return 400. Store it on `PendingState` (`oauth-flow.ts`).
- `oauth-callback.ts` `renderResultPage`: `targetOrigin` becomes the stored
  origin, not `namespaceUrl(worktree)`. Off the pending state (an unknown
  nonce) it keeps today's `"*"` path, unchanged.

This fixes Connect from either host, and keeps the property that the target
origin is validated at the boundary.

### 3. Literals → derived or rewritten

- `website/shell/core/site.ts`: `LOCAL_APP_HOST = namespaceHost(MAIN_WORKTREE_NAME)`
  (core → core import of `infra/namespace/core`, which has zero imports). If the
  website's core cannot take that import, fall back to the literal
  `"equin.localhost:9000"`.
- Rewrite to `equin.localhost` in: `install.sh`, `docs/setup.md`, root
  `CLAUDE.md` (Ports: "main is at `equin.localhost:9000`, the old address
  still answers as an alias"; prototypes line), `prototypes/CLAUDE.md`,
  `e2e-harness/CLAUDE.md`, e2e script headers, the element-picker fixture, the
  `namespace/check` comment, and the research docs. Research is in scope, the
  same choice step 2 made.
- Test fixtures that are sample URLs (crash-kind, image-viewer capabilities,
  relay, scratch launch-fragment, runtime-env, host-fs `isAppOrigin`) move to
  `equin.localhost`. Two keep the old spelling on purpose, because they test
  that the legacy host still resolves: the `isAppOrigin` and
  `gateway/proxy_test.go` cases each gain an `equin` twin.

### 4. Keep it from coming back: `namespace:legacy-host`

A new check in `namespace/check/`, the same shape as `cli:legacy-cli-name`
(`framework/cli/check/legacy-cli-name.ts`, `listCandidateSources` over every
tracked text file, prose included). It fails on any namespace's own host where `NAMESPACE_HOST_LABELS` gives
it a public label (main's old address), and the
hint points at `namespaceUrl` and the public label. Legitimate mentions are
declared in each owner's own `exempt/index.ts` (`kind: "sanctioned"`): the
namespace and gateway tests above, and the namespace CLAUDE.md sentence that
names the legacy alias. Since the hostname is built from the table, the check is
for prose and fixtures. Code cannot spell it by derivation.

### Out of scope

- Renaming the namespace, DB, data dir, or `MAIN_COMPOSITION_ID` (track
  decision item).
- A redirect from the old host (the old host stays a working alias).
- Migrating browser state in code (see below).
- User-visible "equin" labels (step 4). For example, the
  `singularity.auth.complete` postMessage type is an internal wire tag and stays.

## Manual state copy (for the user, once)

On the old address (main's `singularity` host), in the DevTools console:
`copy(JSON.stringify(localStorage))`. Then on `http://equin.localhost:9000`:
`Object.entries(JSON.parse(<paste>)).forEach(([k, v]) => localStorage.setItem(k, v))`
and reload.

## Verification

- `./equin test plugins/infra/plugins/namespace plugins/auth plugins/infra/plugins/host-fs`.
  The namespace tests cover `namespaceUrl(MAIN) === "http://equin.localhost:9000"`,
  the round-trip and legacy-host parsing. The OAuth start tests cover rejecting
  an origin whose host is not the claimed namespace.
- `go test ./...` in `gateway/` (the new `equin` case).
- `./equin check namespace:grammar-in-sync namespace:legacy-host namespace:no-hand-built-url cli:legacy-cli-name`.
- `./equin build`. Its printed URL is the worktree's, so it is unchanged. Confirm
  `./equin run …/e2e-harness/e2e/screenshot.ts --url http://equin.localhost:9000`
  still loads main. The new check must show only the exempted
  lines.
- In the built worktree: the Accounts pane's main link and the Studio
  compositions host column read `equin.localhost:9000`.
- The OAuth Connect flow from both hosts is checked after the push. Central
  runs main's code, so it is verified on main by the user. Note this in the
  hand-off.

## After landing

Update the track page: tick step 3, and set status and next step (step 4,
user-visible labels). File step 4 as the next main task.

## As built

- The check is `namespace:legacy-host`, derived from `NAMESPACE_HOST_LABELS`
  (so a future public label is guarded with no edit). Only
  `namespace/core/namespace.test.ts` is exempted. The gateway test's
  own-name case uses `alpha` instead, and host-fs's `isAppOrigin` fixture uses
  the new host. Neither depended on main's old spelling.
- `oauth-start` takes an optional `origin` param. A bundle built before it
  sends only `worktree` and gets the namespace's handed-out address, the old
  behaviour. `resolveOpenerOrigin` lives in `auth/central/internal/oauth-flow.ts`,
  tested beside it.
- The website download page derives `LOCAL_APP_HOST` / `LOCAL_APP_URL` from
  `namespaceHost` / `namespaceUrl(MAIN_WORKTREE_NAME)`.
