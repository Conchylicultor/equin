# The gateway port: one per-account setting, default 8700, off 9000 (v2)

Task `task-1794945907-6q9ove` (onboarding audit D11). v1 is
`2026-11-17-global-gateway-port.md`. A review against the code found that v1
could kill its own migration and break main. The changes from v1 are marked **(v2)**.

## Context

The gateway's browser port `9000` is written out in many places:

- TS constants (`GATEWAY_PORT`, `DEV_GATEWAY_PORT`);
- the Go `-listen` default;
- the Rust `gateway::PORT`;
- `install.sh`;
- ~50 non-test files spelling `localhost:9000`, including runtime origins such
  as central, OAuth, build and deploy calls, sentinel and boot-watchdog;
- the docs.

9000 is crowded: PHP-FPM, MinIO, Portainer, ClickHouse and SonarQube all use
it. When it is taken by another equin (another account), `./equin start`'s probe
`GET /gateway/worktrees` gets a 200 back and start says "already running".

What the user decided:

- one port setting, read everywhere and enforced;
- default 8700, with fallback through 8709;
- each account keeps its port, and equin says which one it picked;
- existing installs move off 9000, with 9000 answering for a while;
- several instances under one account is out of scope.

## Design

### 1. The port: chosen once per account, then handed down

- **The file.** `~/.equin/state/gateway/port` is a JSON file,
  `{"port": 8700, "legacy": 9000 | null}`, read through a zod schema. It sits in
  the `gatewayState` data dir, which is `state` and never reclaimed. It is
  written atomically, and **only after a gateway is confirmed listening on that
  port (v2)**. Choosing a port never writes it, so a rolled-back switchover
  leaves no file naming a port nothing listens on.
- **The vocabulary** goes in `infra/namespace/core`, a zero-import module that
  already owns the host grammar:
  - `GATEWAY_PORT_RANGE` (8700…8709);
  - `DEFAULT_GATEWAY_PORT`;
  - `LEGACY_GATEWAY_PORT` (9000);
  - a branded `GatewayPort` built only by `asGatewayPort`.

  `GATEWAY_PORT` is deleted. The `port` parameter of
  `namespaceHost` / `namespaceUrl` / `contentUrl` becomes **required** (rung 2).
- **Who reads what (v2).** Each runtime reads the authority that is right for it:
  - **Backends and central** read `EQUIN_GATEWAY_PORT`. The **gateway sets it**
    in every child's environment, derived from its own `-listen`, so a backend
    always agrees with the gateway that spawned it. That holds on the release
    box too, whose port comes from `RELEASE.json` and which has no port file.
    The variable is absent only under a gateway older than this change, and
    such a gateway always listened on 9000, so absent means
    `LEGACY_GATEWAY_PORT`. That fallback is stated in one place, with the
    reason.
  - **CLI, launcher and tooling** read the port file. With no file, they read
    `LEGACY_GATEWAY_PORT`: an install that has not migrated yet still runs on
    9000. A fresh install writes the file during its first `start`, before
    anything reads it.
  - **The page** reads `pageGatewayPort()`, which is its own `location.port`.
    The page was served by the gateway it talks to. An empty `location.port`
    (80) is passed through and never replaced with a constant
    (`page-transport.ts`).
  - **The menu-bar helper** reads the file through `EQUIN_GATEWAY_PORT_FILE`,
    which TS passes in `trayEnv()` (TS owns the layout). With no file it uses
    9000, as above.

  `gatewayPort()` (machine) wraps "env if set, else file, else legacy", and
  `gatewayOrigin()` returns `http://localhost:<port>`. Both live in a new plugin,
  `infra/launcher/plugins/gateway-port` (with core, machine, web and cli barrels).
- **Choosing.** `chooseGatewayPort()` tries 8700…8709 in order. For each, it
  binds `127.0.0.1` and `[::1]` (the gateway's own bind shape) and releases them.
  A taken port is named with its holder (`lsof`). It returns
  `{port, skipped}` and **writes nothing**. If the whole range is taken, it
  fails loudly and lists every holder.
- **`./equin start --port <n>`** is the only way to move a chosen port by hand.

### 2. `./equin start`

- **The identity probe.** `probeGateway(port)` returns `ours | other | none`
  from a new `GET /gateway/identity`, which answers `{product, uid, dataDir}`.
  If that route is 404 but `/gateway/worktrees` answers, it is
  `equin (version before identity)` and treated as unknown, never as "ours".
- **Taken ports.** If the chosen port is held by something else, start fails
  loudly, names the holder and points at `--port`. It never moves silently.
- **What start says.** It prints the port plainly:
  - "equin chose port 8700", or "8700 is taken by `<holder>`, so equin uses 8701";
  - every time: "equin is at http://equin.localhost:8701".

  The file is written after `awaitGatewayReady`.
- **Notion.** When the port changed and Notion has a client configured, start
  says "add `http://localhost:<port>/api/auth/callback/notion` to your Notion
  integration's redirect URIs" (v2).
- **install.sh** gets `APP_URL="$(./equin url)"` after the start step. `url` is
  a new CLI verb that prints main's URL.

### 3. Every reader, converted

- **Runtime literals.** Each `"http://localhost:9000"` is replaced by
  `gatewayOrigin()`. Each `namespaceUrl(...)` call passes `gatewayPort()` or
  `pageGatewayPort()`, or the port as a parameter in core code shared by the
  web and machine sides.
- **e2e scripts (v2)** that drive the live gateway get their origin from the
  harness target. They are not exempt, because they are not sample data.
- **"Is this the local gateway" checks** are rewritten, not re-pointed:
  `site.ts` and the browser MCP `host-session.ts` test "the port is this
  account's / in range".
- **OAuth.**
  - `redirectUriFor(provider, port)`: central uses `gatewayPort()` and the setup
    UIs use `pageGatewayPort()`.
  - `connect.ts`'s `CALLBACK_ORIGIN` becomes the page's own port.
  - The Google config description no longer names a URI.
  - A flow started on 9000 just before the move fails once with
    `invalid_grant`. That is accepted.
- **Go:**
  - `-listen` has no default and is required, except with `-no-keeper` hand
    runs, which must pass it too.
  - gateway/CLAUDE.md's hand-run lines are updated.
- **Docs** say `http://<worktree>.localhost:<port>` and "8700 by default;
  `./equin url` prints this account's".
- **`.mcp.json`'s fallback** becomes `http://equin.localhost:8700`, an exempted
  default with a written reason.

### 4. Migration off 9000: one reload, done by a process the reload cannot kill

- **A port change cannot be a handover.** The keeper holds the sockets, and a
  generation refuses a `-listen` it does not hold, so the switch needs one
  service reload. Main is down for a few seconds and its backends cold-start
  once.
- **(v2) Why the reload moves into a detached helper.** The follow runs inside
  main's deploy run, which the keeper spawned as a child. Unloading the job
  SIGTERMs the keeper, and its `stopChildren` signals the run's whole process
  group. The run dies between unload and load, with no rollback, which leaves
  no gateway until the next login. The existing `no-keeper` reload branch
  never hit this, because a pre-keeper gateway had no `stopChildren`.
- **(v2) The helper.** `follow.ts` hands the switch to a **detached helper**,
  `gateway-port/bin/switch-listen.ts`, spawned in its own session with `setsid`
  (`spawn(..., { detached: true })`). It is not in the keeper's child table or
  in the run's process group, and launchd's bootout kills only the job's group.
  It is given the old definition, the held previous build, the new job and the
  chosen port. In order, it:
  1. waits for the follow to release the machine flock;
  2. runs `reloadService`;
  3. runs `awaitGatewayReady` on the **new** port;
  4. on success, writes the port file with `legacy: 9000` and records the outcome;
  5. on failure, runs `restorePrevious` (definition restored, reload, awaited on
     the old port) and files `gateway-restart-failed`.

  Its log goes to `<log-dir>/gateway-follow/switch.log`. The follow has already
  recorded the launch key, so nothing retries in a loop.
  `restorePrevious` / `reloadService` are shared, not copied.
- **Follow changes.**
  - It dials the **running** gateway at the installed definition's `-listen`.
    An absent flag means `loopback:9000`, the old default. This applies to the
    handover, the old-gateway readiness check and the rollback. `check.ts`'s
    generation read does the same.
  - When the new launch's listen set differs from the running one, it goes to
    the helper and never attempts a handover.
  - The existing `no-keeper` branch goes through the same helper, since it has
    the same latent hazard under a keeper-spawned run.
- **The legacy listener** is `-legacy-listen loopback:9000`. It is passed while
  the port file says `legacy: 9000`, and the helper sets that only for a
  9000-to-new move. A fresh install never listens on 9000.
  - **(v2) No expiry date.** A clock-driven argv would reload at a random later
    push. A follow-up commit deletes the flag, and that push triggers the one
    reload.
  - **It serves exactly as the main port does**: API, WebSocket, `/gateway/*`
    and MCP all work. That keeps running agent sessions (`EQUIN_PARENT_URL` on
    :9000), unrebased worktree builds and open tabs working.
  - **One exception: top-level document navigations get a `308`** to the same
    label, path and query on the new port. A navigation here means
    `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document`.
  - **(v2) What is exempt from the 308:**
    - `?embed=1` documents (the tray panel, the browser extension's popup frame);
    - any request whose `Sec-Fetch-Site` is not `none` / `same-origin`, which
      covers OAuth popups and cross-origin frames;
    - requests from the menu-bar helper's webviews (their UA marker, if the
      helper sets one; otherwise the old helper's pinned-origin panel is
      covered by `embed=1`).
  - Shim windows from the old helper that navigate on 9000 are served there.
  - Bookmarks and typed URLs move.
  - **Binding.** A failed legacy bind (another account holds 9000) is a
    warning. Legacy addresses are optional in `inheritedListeners`, and
    inherited sockets are tagged main or legacy by matching their address. An
    inherited socket that matches neither is an error. The health row's
    gateway detail says when the legacy port is not held.
- **(v2) Per-origin browser storage is not carried.** localStorage and IndexedDB
  on `equin.localhost:9000` (open-tab set, drafts, view state) stay behind; on
  the new origin they start empty. This is a one-time loss, stated in the
  report. The iframe carry-over in v1 needed a principal exemption, a new
  route and a protocol, all for a one-time move.
- **The tray.** The menu-bar login service follows main, so its new binary and
  job arrive on main's boot, before or after the switch. At every probe or
  show, the helper reads the port file and falls back to 9000 when there is
  none. When the origin changes it rebuilds the panel. It rewrites app shims
  baked with another origin when it starts and when the port changes.

### 5. Enforcement: `gateway-port:no-port-literal`

The check fails on:

- `localhost:9000` or `localhost:87\d\d` (also `*.localhost`), in any non-test
  code, Markdown, JSON or shell file;
- a bare `9000` / `870\d` literal in the non-test Go of `gateway/`;
- the same in the Rust of `menu-bar/rust/src`, outside `#[cfg(test)]`.

The check allows:

- test code: `*.test.ts`, `__tests__`, `_test.go` and the Rust test modules,
  which hold sample data;
- `namespace/core/namespace.ts`, the owner;
- declared `exempt/` entries with reasons: `.mcp.json`'s fallback, third-party
  data files, `research/` (out of scope), and the `-legacy-listen` derivation's
  use of `LEGACY_GATEWAY_PORT`, which goes through the constant anyway.

## Implementation slices (disjoint files, parallel)

1. **TS** (me):
   - `namespace/core`, and the `gateway-port` plugin (machine, web, cli `url`,
     bin `switch-listen`, check, exempt);
   - required port at every call site, plus the runtime literals, e2e scripts,
     docs and install.sh;
   - `start`;
   - `dev-launch` / `boot` (port, `-legacy-listen`);
   - `follow` / `check` (dial from the definition, helper);
   - OAuth, and `trayEnv`.
2. **Go:**
   - required `-listen`, plus `-legacy-listen` (keeper-held, tagged, optional,
     non-fatal bind);
   - the 308 wrapper with its exemptions;
   - `EQUIN_GATEWAY_PORT` in the child env;
   - `GET /gateway/identity`;
   - tests (incl. a handover carrying both sets, and one with the legacy socket
     missing), and gateway/CLAUDE.md.
3. **Rust:**
   - `port()` from `EQUIN_GATEWAY_PORT_FILE`, with 9000 when the file is absent;
   - panel rebuild on an origin change;
   - shim origin rewrite;
   - the offline-page text;
   - tests, and menu-bar CLAUDE.md.

## Verification

- `./equin check`.
- `./equin test` on the touched plugins.
- `go test ./...` in `gateway/` and the cargo tests, via their usual routes.
- `./equin build` of this worktree, which runs under the current 9000 gateway.
  The app works there, and backends there get no `EQUIN_GATEWAY_PORT`, so they
  read 9000.
- A **keeper rehearsal** of the switch on spare ports, with an `EQUIN_DIR`
  sandbox and a throwaway service label:
  1. start a keeper on `loopback:8790`;
  2. spawn a child that launches the detached helper, which reloads it onto
     `-listen loopback:8791 -legacy-listen loopback:8790`;
  3. check that the helper survives the old keeper's `stopChildren`;
  4. check with curl: a navigation on 8790 gets a 308 to 8791, `?embed=1` and
     the API are served, `/gateway/identity` answers, and the port file is
     written only on success;
  5. a forced failure (a bad binary) rolls back to 8790 and writes no file.
- After the push, main's follow migrates this machine. Then check:
  - the port file;
  - `http://equin.localhost:8700`;
  - a 308 from `:9000/agents`;
  - this conversation's MCP, after the main backend restart;
  - the tray panel.

## Manual steps for the user

- **Notion:** add `http://localhost:8700/api/auth/callback/notion` to the
  integration's redirect URIs. **Google** Desktop client: nothing.
- Open tabs on `:9000` keep working until reloaded, then move. Tab sets and
  drafts kept in browser storage on `:9000` start empty on `:8700`.
- Chrome "installed app" windows created from `:9000`, if any, need
  re-installing.
