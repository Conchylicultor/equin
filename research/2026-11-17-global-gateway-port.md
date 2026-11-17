# The gateway port: one per-account setting, default 8700, off 9000

Task `task-1794945907-6q9ove` (onboarding audit D11).

## Context

The gateway's browser port is `9000`. It is spelled as a TS constant
(`GATEWAY_PORT`, `DEV_GATEWAY_PORT`), as a Go flag default (`-listen loopback:9000`),
as a Rust const (`menu-bar/rust/src/gateway.rs` `PORT`), in `install.sh`, in
~15 runtime `"http://localhost:9000"` literals (central origin, OAuth redirect,
build/deploy calls, sentinel, boot-watchdog) and across the docs. 9000 is used by
PHP-FPM, MinIO, Portainer, ClickHouse and SonarQube. When it is taken, `./equin start`
probes `GET /gateway/worktrees` and, if it gets a 200 back, prints "already running
(started outside this command)" and stops. Another account's equin passes that probe.

The user decided:

- one port setting, read everywhere and enforced;
- a default of **8700**, with fallback through **8709**;
- each account keeps the port it got, and equin says which one;
- existing installs move off 9000, with 9000 answering for a while;
- several instances under one account is out of scope.

## Design

### 1. The port is per-account data, chosen once

- **The file.** `~/.equin/state/gateway/port` holds one decimal number. It sits in
  the `gatewayState` data dir (`infra/launcher/data-dirs`), which is `state`, never
  reclaimed.
- **The vocabulary** goes in `infra/namespace/core`, the existing owner of the
  host grammar and a zero-import module:
  - `GATEWAY_PORT_RANGE = { first: 8700, last: 8709 }`;
  - `LEGACY_GATEWAY_PORT = 9000`;
  - a branded `GatewayPort` built only by `asGatewayPort(n)`;
  - `gatewayPortOfUrl(url)` for the page.

  `GATEWAY_PORT` is deleted.
- **Callers must pass a port.** The `port` parameter of `namespaceHost`,
  `namespaceUrl` and `contentUrl` becomes **required** (rung 2). A caller can no
  longer get the port silently from a constant. ~60 call sites get the port from
  their own runtime:
  - **machine, server, central and CLI:** `gatewayPort()` from a new
    `infra/launcher/plugins/gateway-port` `machine` barrel. It reads the file once
    per process. Every port change restarts the keeper, and with it every
    backend; CLI runs are short. If the file is missing it throws
    `GatewayPortUnsetError` ("equin has not chosen its port yet — run
    `./equin start`").
  - **web:** `pageGatewayPort()` (web barrel), which is the page's own
    `location.port`. A page is always served by the gateway it talks to.
  - **core code shared by both** takes the port as an argument.
- **Choosing the port.** `ensureGatewayPort()` (machine) returns the file's
  value. If there is no file, it tries 8700…8709 in order: it binds `127.0.0.1:p`
  and `[::1]:p` (the gateway's own bind shape) and releases them. It writes the
  first free port atomically and returns `{ port, chosen: true, skipped: [{port, holder}] }`.
  `holder` comes from `lsof -nP -iTCP:<p> -sTCP:LISTEN`. Only `./equin start`
  and the main follow (§3) call it. Read-only paths (the health row, checks)
  call `readGatewayPort()`, which returns a `{kind:"set"|"unset"}` state and
  never writes.
- **Moving by hand.** `./equin start --port <n>` (n in range, free) rewrites the
  file and restarts the service. This is the only way to change a chosen port.
- **No free port in the range** is a loud failure. It names each port's holder.

### 2. Everything reads that one value

| Reader | How |
|---|---|
| Go gateway | `-listen` becomes **required**: no default in `main.go`. The launcher always passes `loopback:<port>`. A new `-legacy-listen loopback:9000` flag is covered in §4. |
| Launcher | `devGatewayLaunchOptions({repoRoot, logLevel, port})`. `devBindHost` checks `EQUIN_LISTEN`'s port against the given port instead of 9000. |
| Backends, central, CLI | `gatewayPort()`. Every `"http://localhost:9000"` literal becomes `gatewayOrigin()` (`http://localhost:<port>`, same barrel), e.g. `central-store.ts`, `get-token.ts`, `build/cli/run.ts`, `deploy-namespace.ts`, `legacy-dist-reap.ts`, `request-convergence.ts`, `sentinel`, `boot-watchdog`, `backend-liveness`, `backend-hold`. |
| Agent sessions | `EQUIN_PARENT_URL` is already built with `namespaceUrl`, so it carries the port. The `.mcp.json` fallback becomes `http://equin.localhost:8700`, an exempted default with a written reason: it only applies when Claude Code runs outside an equin-launched session. |
| Menu-bar helper (Rust) | `trayEnv()` passes `EQUIN_GATEWAY_PORT_FILE=<path>`, so TS owns the layout. `gateway::PORT` becomes `gateway::port() -> Result<u16, PortUnset>`, read from the file at every probe/show. An unset or unreadable file gets the bundled offline page, which says "equin has not started yet". The `frontend/index.html` text loses its literal. Login services follow main (`login-services/machine/internal/follow-main.ts`), so the rewritten job and new binary reach the running tray without `./equin start`. App shims baked with an old origin (`shim.rs` `EquinUrl`) are rewritten to the current port when the helper starts. |
| Browser extension | Already port-agnostic (`http://*.localhost/*`). `write-shell.ts` passes `gatewayPort()` to `namespaceUrl`. The next build rewrites `popup.html`, and the shell self-updates. |
| OAuth | `redirectUriFor(provider, port)` uses the account's port (central: `gatewayPort()`; the setup UIs: `pageGatewayPort()`). `auth-google`'s description and `oauth-client-setup.tsx` / `google-setup.tsx` show the live URI. Google Desktop clients accept any loopback port. Notion needs the user to re-add the new redirect URI (final report). |
| `install.sh` | A new `./equin url` verb prints main's URL (`namespaceUrl(MAIN, "", gatewayPort())`). `APP_URL="$(./equin url)"` runs after the start step. Shell never spells the port. |
| Docs / CLAUDE.md | The text says `http://<worktree>.localhost:<port>`, plus "8700 by default; `./equin url` prints this account's". The root CLAUDE.md "Ports" section is rewritten. The build output already prints the real URL. |
| Website `site.ts`, browser MCP `host-session.ts` | "Is this the local gateway" becomes "the port is this account's" (or in range on the page). |

### 3. `./equin start` and the port it is on

- **The identity probe.** `isGatewayListening(port)` becomes
  `probeGateway(port) → ours | other-equin | foreign | none`, using a new
  `GET /gateway/identity` → `{ product: "equin", uid, dataDir }`. A foreign or
  other-account listener is no longer reported as "already running".
- **What start says.** It prints the port in plain words:
  - first choice: "equin chose port 8700";
  - fallback: "8700 is taken by `<holder>`, so equin uses 8701";
  - every time: "equin is at http://equin.localhost:8701".

  The same line goes to install.sh's `done` event.
- **The chosen port is taken at a later start** (by a foreign process): a loud
  error that names the holder, with `./equin start --port <n>` as the way out.
  The port never moves silently, because bookmarks and OAuth depend on it.

### 4. Migration: existing installs move off 9000

- **Why a restart is unavoidable.** A port change cannot be a handover. The
  keeper holds the listening sockets, and a generation refuses a `-listen` it
  does not hold (`generation.go` `inheritedListeners`). A keeper-held port set
  only changes with a keeper restart, so the move is **one service reload**: the
  same path `followMainGateway` already takes for a pre-keeper gateway
  (`reloadService` + `awaitGatewayReady` + `restorePrevious` on failure). Main
  is down for the reload's few seconds and its backends cold-start once. It is
  never left down: a gateway that does not come up is rolled back onto 9000 by
  the existing rollback.
- **Follow changes** (`gateway-drift/cli/internal/follow.ts`):
  - It calls `ensureGatewayPort()`, which chooses 8700 on an existing install
    (no file yet).
  - It dials the **running** gateway at the address from the installed
    definition's `-listen` (absent → `loopback:9000`, the old Go default), never
    at a constant. That covers the handover, the readiness check of the old
    gateway, and the rollback.
  - When the new launch's listen set (`-listen`, `-legacy-listen`) differs from
    the running one, it skips the handover (it would fail by construction) and
    reloads.
  - The new gateway is awaited on the **new** port.
  - `gateway-drift/machine/internal/check.ts` likewise reads the running
    generation at the definition's address.
- **9000 keeps answering for a while: `-legacy-listen loopback:9000`.**
  - The launcher passes it while `LEGACY_GATEWAY_PORT_UNTIL` (a date in
    `namespace/core`, 2027-02-01) is in the future, and only for an account
    that migrated from 9000. A fresh install never listens on 9000. The file
    records `{"port":8700,"legacy":9000}`, so it is JSON, not a bare number.
  - On that listener the gateway serves exactly as on the main port, with one
    difference: a **top-level document navigation** (`Sec-Fetch-Mode: navigate`
    + `Sec-Fetch-Dest: document`) is answered with `308` to the same label,
    path and query on the new port. Bookmarks, OAuth callbacks registered on
    9000 and reloads of old tabs follow it.
  - Everything else (API, WebSocket, `/gateway/*`, MCP) is proxied as usual.
    Agent sessions that are still running, with `EQUIN_PARENT_URL` on `:9000`,
    worktree builds on branches that are not rebased (they POST
    `localhost:9000/gateway/...`) and open tabs' sockets keep working until
    they end.
  - A bind failure on the legacy address is a warning, never fatal: another
    account may hold 9000.
  - When the date passes, the next follow sees a changed listen set and
    reloads once more without it. A follow-up task deletes the flag and date
    after that.
- **Per-origin browser state moves too.** localStorage is per origin, and the
  port is part of the origin: the open-tab set, drafts and view state live
  there. The gateway's legacy listener serves `GET /gateway/legacy-storage`, a
  tiny page that postMessages its `localStorage` entries to its parent. The
  only parent it accepts is `http://<same label>.localhost:<this account's port>`.
  - On the new origin, the web-storage primitive
    (`primitives/dom/web-storage`) runs this once per origin, behind a done
    flag, and only while `pageGatewayPort()` ≠ 9000 and the legacy window is
    open. It mounts a hidden iframe on the 9000 twin and imports the keys the
    new origin lacks.
  - The two origins are same-site (a site ignores the port), so the iframe's
    storage is not partitioned.
  - IndexedDB is not carried (browser-host data only). This is accepted.
- **Worktrees on this machine.** They need nothing beyond the above:
  - A worktree's next `./equin build` writes namespace URLs with the new port.
  - Its running backend is restarted by the reload.
  - Old branches keep working against the legacy listener until rebased.

### 5. Enforcement: `gateway-port:no-port-literal` check

The check lives in `infra/launcher/plugins/gateway-port/check`. It fails on:

- `localhost:9000` or `localhost:87\d\d` (any `*.localhost` host too) in
  non-test code, Markdown and JSON;
- a bare `9000` / `870\d` in the non-test Go of `gateway/` and the Rust of
  `menu-bar/rust/src`;
- either of those in `install.sh` and `sidequests/**/*.sh`.

What it allows:

- **Test code** (`*.test.ts`, `__tests__`, `_test.go`, `#[cfg(test)]`): its URLs
  are sample data, the same stance `namespace:no-hand-built-url` takes.
- **The owner module** `namespace/core/namespace.ts`.
- **Declared exemptions** (`exempt/index.ts`, with a reason): `.mcp.json`'s
  fallback, `research/` (out of scope), third-party data files
  (`catalog.json`, `symbols-metadata.json`, `litellm-fallback.json`).

Its docstring and that of `namespace:no-hand-built-url` cross-reference each
other.

## Implementation slices

Parallel where the files are disjoint:

1. **Core, launcher, start, follow and check (TS).**
   - `namespace/core` vocabulary; the new `gateway-port` plugin (machine + web +
     cli `url` verb + check + exempt); required port on `namespaceUrl`/`Host`/`contentUrl`
     and every call site; all runtime literals.
   - `start` (choose, identity probe, `--port`, plain message).
   - `dev-launch`/`boot.ts` (`port`, `-legacy-listen`); `follow.ts`/`check.ts`
     (dial from the definition, reload on a listen change).
   - OAuth; web-storage carry-over; install.sh; docs.
2. **Go gateway.** Required `-listen`; `-legacy-listen` (a second listener set
   held by the keeper and inherited the same way: `listenAll`, `inheritedListeners`,
   keeper fd list; non-fatal bind); the navigation-redirect wrapper on legacy
   listeners; `GET /gateway/identity`; `GET /gateway/legacy-storage`; tests; gateway/CLAUDE.md.
3. **Rust menu-bar helper.** `port()` from `EQUIN_GATEWAY_PORT_FILE`; offline-page
   text; shim origin rewrite; tests; menu-bar CLAUDE.md. `trayEnv()` on the TS side.

## Verification

- `./equin check` (incl. the new check, `type-check`, `namespace:*`, `plugins-doc-in-sync`).
- `./equin test` on `infra/namespace`, `infra/launcher` (+ gateway-drift, login-services),
  `framework/cli/start`, `auth`, `companions/menu-bar`, `web-storage`. Go: `go test ./...`
  in `gateway/` (via `./equin test gateway` if that is the route). Rust: cargo tests via the
  deps build.
- `./equin build` of this worktree. This worktree runs on the current (9000)
  gateway, so the browser checks here prove the app still works under a
  non-default `location.port`. They cannot prove the switchover.
- **Switchover rehearsal** before pushing:
  - Run the new gateway binary by hand as a throwaway, with `-no-keeper` and
    then with a keeper, on spare ports: `-listen loopback:8790
    -legacy-listen loopback:8791`, an `EQUIN_DIR` sandbox and no `-main-checkout`.
  - `curl` checks:
    - a navigation on 8791 → 308 to 8790;
    - an API request on 8791 → proxied;
    - `/gateway/identity`;
    - `/gateway/legacy-storage`.
  - Go tests cover the keeper inheriting both listener sets across a handover.
  - Follow's dial-from-definition and reload-on-listen-change are unit-tested on
    stubbed definitions.
- After push, main's follow migrates this machine. Confirm:
  - `~/.equin/state/gateway/port` holds `{"port":8700,"legacy":9000}`;
  - `http://equin.localhost:8700` serves;
  - `http://equin.localhost:9000/agents` 308s;
  - this conversation's MCP (on :9000) still works;
  - the tray panel loads.

  If the follow failed, its `gateway-restart-failed` report says why, and the
  rollback left 9000 serving.

## Manual steps for the user (final report)

- **Notion:** add `http://localhost:8700/api/auth/callback/notion` to the
  integration's redirect URIs. **Google:** nothing (a Desktop client accepts any
  loopback port).
- Chrome "installed app" windows created from `:9000`, if any, need
  re-installing from the new origin.
