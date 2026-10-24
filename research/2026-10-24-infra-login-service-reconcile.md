# Login services follow main: boot reconcile, `start --only`, visible gateway staleness

## Context

A declared login service (today only the menu-bar tray, `dev.equin.menu-bar`)
is written and (re)loaded **only by `./equin start`**. Main's auto-build after
a push redeploys frontend + server and never touches it, so a change to
`plugins/menu-bar/rust/` reaches the tray only when someone remembers to run
`./equin start`. Two smaller gaps sit next to it:

- `start --force` is all-or-nothing: it restarts the gateway (every backend)
  just to restart the tray.
- `prepareGateway`'s comment claims "a Go change takes effect on the next
  `start` with no flag" — false: `startAsLoginService` returns before
  `prepareGateway` when the gateway is already running, so a changed gateway
  binary is neither built nor mentioned without `--force`.

Goal: every declared login service follows main by itself; the gateway stays
manual (restarting it restarts every backend) but its staleness becomes
visible; one service can be restarted alone. **Generic** — nothing names the
menu bar; a second declaration gets all of it for free.

## How change is detected (existing, reused)

1. **Dep identity** — the declaration's `dep` (for the tray a `cargoBuild`) has
   an identity hashed from its inputs (crate files via `git ls-files`, Cargo.lock,
   `rustc -vV`, target): `plugins/infra/plugins/deps/plugins/build/deps/internal/build.ts:143`.
   `readyNow(dep)` says whether that identity is built without building.
2. **Job diff** — the job's argv names the binary under
   `cache/deps/<id>/<identity>/`, so a new identity renders a different
   definition; `LoginService.write(job)` returns `changed`
   (`machine/internal/definition-file.ts`).

## Design

### 1. One per-service reconcile, shared by `start` and the boot hook

New `login-services/machine/internal/reconcile.ts`:

```ts
export type ReconcilePolicy =
  | "start"        // ./equin start: load when not running, reload when changed
  | "force"        // ./equin start --force: always (re)load
  | "follow";      // main's boot: only a service that is registered AND loaded is
                   //   reloaded when its job changed; registered-but-unloaded
                   //   (a `stop`) gets its definition rewritten, never loaded;
                   //   unregistered (never `start`ed / `stop --disable`) is untouched
export type ReconcileOutcome =
  | { kind: "unregistered" }
  | { kind: "unchanged"; pid: number | null }
  | { kind: "rewritten" }                       // definition updated, not loaded
  | { kind: "started"; pid: number; path: string; reloaded: boolean };

export async function reconcileLoginService<S>(
  service: LoginService, decl: LoginServiceDeclaration<S>, ready: Ready<S>,
  policy: ReconcilePolicy,
): Promise<ReconcileOutcome>
```

Body = today's loop body of `startDeclaredLoginServices`
(`plugins/framework/plugins/cli/plugins/start/cli/run.ts:155`): `holdDep(ready,
loginServiceHolder(decl))`, `write(loginServiceJob(decl, ready))`, unload +
`awaitProcessGone` when loaded, truncate the stdio log (mkdir its folder), `load`.
"Registered" = `existsSync(service.definitionPath())`; the `follow` check runs
**before** holding/writing anything. `awaitProcessGone` moves (or is
re-exported) so machine code can reach it without importing the launcher's
`server` barrel — check `boundary-rules` and pick the lowest folder that both
`launcher/server` and `login-services/machine` may import (likely move it into
`login-services/machine` or a `core` helper; launcher re-imports it).

`start`'s loop becomes: `ensureDep` (unchanged — the CLI may build in the
foreground) → `reconcileLoginService(…, opts.force ? "force" : "start")` →
print the outcome.

### 2. Main-boot reconcile (`login-services/machine` `onReady`)

The `machine` barrel is already a `MachinePluginDefinition`; add `onReady`
(logic in `machine/internal/follow-main.ts`):

```
onReady: if (!isMain() || loginServiceManager() === null) return
  for decl of declaredLoginServices():
    service = manager.service(loginServiceId(decl))
    if (!registered(service)) continue            // opt-in: start registered it
    now = await readyNow(decl.dep)                // main's checkout = REPO_ROOT
    ready      → reconcileLoginService(service, decl, now.ready, "follow")
    failed     → throw (surfaces as a report; old service keeps running)
    absent / installing → onDepInstallSettled(decl.dep, retry once); requestDep(decl.dep)
```

- **No watcher, no poll**: main's checkout moves only on push, and every push
  restarts main's backend (auto-build) → `onReady` runs. A long cargo build
  runs in the `deps.install` supervised child (`requestDep`,
  `plugins/infra/plugins/deps/server/internal/install-job.ts`), off boot; the
  old tray keeps serving meanwhile. Subscribe before requesting (same order as
  `menu-bar/machine/internal/install.ts:awaitHelper`).
- Not awaited by boot (`void follow()` with the rejection left loud, as
  `menu-bar/machine` does), so a slow identity hash never delays readiness.
- Per-service `createKeyedMutex` (`packages/keyed-mutex`) so a settle firing
  while a boot reconcile runs never double-reloads the same service.
- The gateway is not a declaration, so it is excluded by construction.
- launchd: `launchctl bootout/bootstrap gui/<uid>` from the backend (itself
  under the gateway LaunchAgent, same user and Aqua session) works; systemd:
  `systemctl --user`. Both through the existing `LoginService` — no new
  manager code.

### 3. `./equin start --only <id…>`

`--only <ids>` (comma-separated; Commander `<value>`), each a declared login
service id or the gateway's label `dev.singularity.gateway`
(`GATEWAY_SERVICE.label`). An unknown id fails before anything runs, listing
the known ones. Restricts both halves: the gateway half runs only when the
gateway is selected (or no `--only`); declarations are filtered. Combined with
`--force` it is the per-service restart: `./equin start --only dev.equin.menu-bar --force`.
Prerequisites/toolchain still run (cheap, and the gateway half needs them).

### 4. Gateway staleness visible without `--force`

In `startAsLoginService`, the "already running under the manager, no force"
branch no longer returns blind: it runs `prepareGateway` (ensureDep is a hash
when nothing changed; a Go change builds it), computes `gatewayServiceJob(spec)`
and asks the service whether its definition is current — new
`LoginService.isCurrent(job): boolean` (compare rendered content with the file,
next to `write` in `definition-file.ts`, both managers). Stale → print
"The gateway binary changed since the running gateway started (<old dir> →
<identity>). It keeps running the old one; `./equin start --only
dev.singularity.gateway --force` swaps it (restarts every backend)." The
definition is **not** rewritten and the hold is **not** moved in that branch,
so the plist keeps naming the running, held binary (moving the hold would let
the daily sweep delete the live gateway's install dir). Fix the
`prepareGateway` comment to say exactly this. Same policy as the existing
legacy-pid branch ("swapping the live gateway … only an explicit --force asks
for").

`signGateway` and `holdDep` move after the staleness decision so the non-force
branch neither signs nor holds the new build.

## Files

- `plugins/infra/plugins/launcher/plugins/login-services/machine/internal/reconcile.ts` (new) + `reconcile.test.ts`
- `…/login-services/machine/internal/follow-main.ts` (new); `machine/index.ts` (`onReady`, export `reconcileLoginService`)
- `…/login-services/machine/internal/login-service.ts`, `definition-file.ts`, `launchd.ts`, `systemd.ts` (`isCurrent`)
- `plugins/framework/plugins/cli/plugins/start/cli/{index,run}.ts` (`--only`, shared reconcile, staleness)
- `plugins/infra/plugins/launcher/server/…` (`awaitProcessGone` location, if moved)
- Docs: `login-services/CLAUDE.md` (Declaring one → start/boot/`--only`), `launcher/CLAUDE.md`, `menu-bar/CLAUDE.md` (the `login-services/` paragraph: follows main by itself).

## Verification

- `./equin test plugins/infra/plugins/launcher/plugins/login-services` — reconcile
  against a fake `LoginService` (in-memory definition + state) and a fake dep
  (`readyForTests`): each policy × {unregistered, registered-unloaded, loaded}
  × {job same, job changed}; `follow` never loads an unloaded service and never
  touches an unregistered one.
- `./equin check` (boundary-rules, type-check, plugins-doc-in-sync).
- `./equin build` of this worktree (worktree boot must be a no-op: `isMain()` false).
- Manual, by the user after push (agents never run `start`): edit a comment in
  `plugins/menu-bar/rust/src/main.rs`, push → main's backend log shows the
  helper build requested, then the tray PID changes
  (`launchctl print gui/$UID/dev.equin.menu-bar`). `./equin start --only
  dev.equin.menu-bar --force` restarts only the tray (gateway PID unchanged);
  `./equin start` after a Go change prints the stale-gateway line.
