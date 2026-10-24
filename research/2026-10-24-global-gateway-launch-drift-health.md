# Health report: say when the machine's gateway is out of date

## Context

A change to the gateway's launch (its Go source → a new `gateway-binary`
identity, a flag in `gatewayLaunchSpec`, the bind default, the codesign
identity) never reaches the running gateway by itself. With the gateway loaded
under launchd/systemd, a plain `./equin start` returns early after
`reportStaleGateway` prints one line nobody reads twice; nothing rewrites the
plist / unit, nothing reloads it, and after a reboot the manager keeps starting
the old binary with the old argv. Live example: 852366c798 made the default
`-listen loopback:9000` and signs the gateway with a stable identity; the
running gateway still has `-listen :9000` and the ad-hoc binary.

Wanted: the health report says when the installed or running gateway differs
from what `./equin start --force` would install now, and tells the user to run
it. Placement: one more plain status row in the infrastructure group (the
folded "Connection, Database, Live reads" card), not a new top-level entry.

## What "would install now" means

`start` always installs **main's** gateway (`prepareGateway` ensures
`gatewayBinary` from `getMainRepoRoot()`), so the reference is main's, whichever
checkout's backend asks. A backend cannot reproduce `start`'s whole job
byte-for-byte: the plist's `EnvironmentVariables` are `pickRuntimeEnv` of the
**starter's shell**, which a backend never sees (its own env is the gateway's
forwarded subset, re-pinned PATH). So the check compares the parts a backend
derives exactly, and ignores env:

1. **argv** — rebuilt with `gatewayLaunchSpec(devGatewayLaunchOptions(…))`:
   - argv[0]: `builtFile` of main's `gatewayBinary` (`readyNow(…, { root:
     mainRoot })`; `absent`/`installing` ⇒ main's source has moved past the
     installed build, which is stale by itself);
   - `-listen` from `SINGULARITY_LISTEN` (forwarded to every backend, so it
     reads what the starter had) or loopback;
   - `-log-level` is a `start` flag, so it is taken from the installed argv
     (not a drift);
   - every other flag (`-child-env` carries `runtimeEnvNames()`, so a newly
     declared runtime variable shows up here too).
2. **cwd** — main's checkout.
3. **signature** — macOS only: the installed binary satisfies
   `isSignedBy(path, "dev.singularity.gateway", <machine identity sha1>)`; the
   identity read without side effects (configured value or the existing local
   PEM — never minting one).
4. **running vs installed** — the running gateway (pidfile) was started with
   the installed argv (`/proc/<pid>/cmdline` on Linux, `ps -ww -o args=`
   elsewhere, compared as the joined string). Catches a definition written but
   never reloaded (legacy hand-over, an interrupted `start`).

Not-applicable (hollow row, out of the merge): no service manager; a release
(`isRelease()`); no installed definition whose `-pid-file` is this runtime's
(a preview / serve-app under another data root does not run behind the
machine's login-service gateway).

## Design

### `login-services` (machine): read a definition back

`LoginService.installedJob(): { argv; cwd } | null` — the parsed definition, via
pure inverses of the renderers: `parseLaunchAgentPlist` (ProgramArguments
`<string>`s + WorkingDirectory, XML-unescaped) and `parseSystemdUserUnit`
(ExecStart C-unquoted, `$$`→`$`, WorkingDirectory). Round-trip tests against the
renderers.

### `launcher` server: one derivation of the dev launch options

Move `DEFAULT_PORT` / `devBindHost()` out of `start/cli/run.ts` into
`launcher/server` as `DEV_GATEWAY_PORT` + `devGatewayLaunchOptions({ gateway,
repoRoot, logLevel })`, used by `start` and by the drift check — so the check
cannot drift from what `start` writes.

### `launcher` deps: the signature question

`gatewaySignature(path)` → `unsupported | signed | unsigned | no-identity`
beside `signGateway` (owns `GATEWAY_CODESIGN_IDENTIFIER`).

### New sub-plugin `infra/launcher/plugins/gateway-drift`

- `core`: `GatewayDriftSchema` (`not-applicable {reason}` | `current` |
  `stale {differences: string[]}` | `unreadable {message}`) and the
  `gatewayDrift` `liveValue` (`needsMachine`), plus `GATEWAY_REFRESH_COMMAND =
  "./equin start --force"`.
- `machine`: `checkGatewayDrift()` (the four comparisons above, each
  difference a short human phrase: "-listen :9000 → loopback:9000", "binary
  built from older gateway source", "not signed by this machine's identity",
  "running gateway was started with a different command than the installed
  one"); a pure `diffGatewayArgv(installed, expected)` for the argv part
  (flag-pair map, bun-tested). Served with `serveValue(…, { source: "external",
  changes: "notified" })`; the answer is cached and recomputed when older than
  10 min on read, and on every advance of `refs/heads/main`
  (`defineRefReaction`) — the only thing besides a gateway restart (which
  restarts every backend, so it recomputes anyway) that moves the verdict.
- `web`: `HealthReport.Row({ kind: "status", id: "gateway", title: "Gateway",
  order: 40, useStatus })` — no glance/component/actions, so it folds into the
  quiet card while `ok` ("Connection, Database, Live reads, Gateway"); when
  stale it is `attention`: "Out of date (‹differences›) — run `./equin start
  --force`" (and, like every row in that card, it leaves it while not ok).

`start`'s own stale notice keeps working (it still uses `isCurrent`, the full
render incl. env).

## Files

- `plugins/infra/plugins/launcher/plugins/login-services/machine/internal/{launchd-plist,systemd-unit,launchd,systemd,login-service}.ts` (+ tests)
- `plugins/infra/plugins/launcher/server/internal/dev-launch.ts` (new), `server/index.ts`
- `plugins/infra/plugins/launcher/deps/internal/gateway.ts`, `deps/index.ts`
- `plugins/framework/plugins/cli/plugins/start/cli/run.ts` (use the shared options)
- `plugins/infra/plugins/launcher/plugins/gateway-drift/{core,machine,web}` (new)
- docs: launcher + start + login-services `CLAUDE.md`

## Verification

- `./equin test` on the new parser round-trips and `diffGatewayArgv`.
- `./equin build`, then on this machine (whose gateway has `-listen :9000`):
  `curl` the resource / open the health report at
  `http://att-1792865924-s2kdk0.localhost:9000` and see the Gateway row in
  attention naming `-listen` and the binary; `./equin check`.
