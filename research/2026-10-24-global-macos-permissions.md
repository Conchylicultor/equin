# macOS permissions: stop agents prompting as "gateway"

## Context

A dialog appeared: *"gateway" wants access to control "System Events"*. It came from the
menu-bar agent (conv-1792796034-ljzk6h) checking its test app with `osascript … System Events`.
The audit found:

- **Every agent is attributed to the gateway.** launchd → gateway → backend → `bun agent.ts` →
  `claude` → bash. TCC charges the *responsible process* (the launchd-started gateway), so every
  prompt says "gateway" and one Allow covers every agent forever, bypass-permission agents included.
- **Grants don't survive a rebuild.** The gateway is ad-hoc linker-signed (`Identifier=a.out`) at a
  content-hashed path. TCC keys ad-hoc binaries by cdhash, so each gateway rebuild drops grants such as
  Downloads for the File Explorer, re-prompts, and leaves another stale "gateway" row in Settings.
- **Nothing in the repo needs** System Events, Accessibility, Screen Recording or Full Disk Access.
  The only legitimate needs are Files & Folders (Downloads, volumes) when the File Explorer browses
  them.
- **The gateway binds `:9000` on every interface.** The firewall is off, so this causes no prompt, but
  it exposes the app to the LAN. The Hosted track (wiki "Hosted") reaches the phone through Tailscale
  to a separate server with zero open ports, so the Mac never needs LAN binding.

Goal: agents can't trigger automation prompts by accident. When they do prompt, the dialog names
`claude`, not the gateway. The gateway's own grants survive rebuilds. The gateway is loopback-only.

Four independent changes, each landable alone. The order below is by size (smallest first); the two
native ones start with a spike.

---

## 1. Guard `macos-automation`

`G` = `plugins/framework/plugins/tooling/plugins/guards`.

- **New `G/core/guards/macos-automation.ts`** containing
  `defineGuard<BashInput>({ name: "macos-automation", matcher: "Bash", bypassToken: ".allow-macos-automation", check })`.
  Precedent: `G/core/guards/postgres.ts` (a set of names checked through `findCall` from `G/core/parse-shell.ts`).
  - Blocks by command name, with no argument analysis: `osascript` (every form), `screencapture`,
    `automator`, plus `cliclick` and `peekaboo`. `shortcuts` is blocked only when `args[0] ∈ {run, sigma}`.
  - Not blocked: `open`, `lsappinfo`, `pgrep`, `ps`, `pbcopy`, `say`, `defaults`, `mdfind`, `tccutil`.
  - What `parseShell` already handles: absolute paths (basename), `$(…)`, backticks, subshells,
    `env`/`sudo`/`nohup`/`xargs`/`exec`. It does **not** look inside `bash|sh|zsh -c "<str>"` or
    `eval "<str>"`. Fix that with a local recursive `findAutomation(cmd, depth≤3)` that re-parses the
    `-c` argument (flags matching `/^-[a-z]*c[a-z]*$/`) or the joined `eval` args. `parse-shell.ts`
    itself stays unchanged, so other guards don't need a replay.
  - Export `MACOS_TCC_COMMANDS` from `G/core` so the deny list in section 1b uses the same list.
  - Denial: `why` = the command raises a macOS permission prompt on the user's screen and nothing in
    the repo needs it. `hint` = for "is it running?" use `pgrep -x` / `lsappinfo list` / `ps`; for
    screenshots use the e2e harness or the `browser_screenshot` MCP tool; `open <url>` is fine.
    The standard epilogue already names the bypass file.
- Register it in the judging block of `G/core/registry.ts`, before the rewriters. The bypass chip
  picks it up automatically because `BYPASS_TOKENS` is derived from the registry.
- Add the known gaps to `G/CLAUDE.md`: `arch -arm64 osascript`, `python -c subprocess(...)`, and
  command names built at runtime.

**1b. Scratch profiles** (such as help.ask) don't load the repo's `.claude/settings.json`, so the guard
never runs for them. In `plugins/conversations/plugins/workspace/plugins/scratch/server/internal/launch-fragment.ts`,
always merge `permissions.deny: ["Bash(<cmd>:*)" …]` built from `MACOS_TCC_COMMANDS`, combined and
deduplicated with each profile's own deny list. Don't inject the guard hook there: `$CLAUDE_PROJECT_DIR`
points at the wrong directory, the guard assumes a worktree, and the hook would run twice for repo agents.
Update `launch-fragment.test.ts` accordingly.

**Tests:** `G/core/guards/macos-automation.test.ts` (bun:test, same pattern as `bun-script.test.ts`).
Blocked: each form above, including nested `bash -c "bash -c 'osascript'"` and `shortcuts run X`.
Allowed: `echo osascript`, `rg osascript`, `git commit -m "osascript"`, `shortcuts list`, a heredoc
whose body mentions osascript. Bypass: create the file in a temp dir and build the context with `createContext(dir)`.

## 2. Gateway listens on loopback by default (127.0.0.1 and ::1)

- **`plugins/infra/plugins/launcher/server/internal/listen.ts`:** add the host keyword `LOOPBACK_BIND = "loopback"`.
  `resolveListenAddress` returns `{host: "loopback"}` when `SINGULARITY_LISTEN` is unset. An explicit
  `:9000` stays `host: null`, which means every interface, and is the opt-in. Update the header comment and error text.
- **Make the wildcard explicit in the types.** `GatewayLaunchOptions.bindHost` becomes required
  (`string | null`, where null means every interface). Drop the `?? null` default in `boot.ts` (~L479)
  so a future caller that omits it can't get a wildcard by accident. Update the callers:
  `plugins/framework/plugins/cli/plugins/start/cli/run.ts` (`devBindHost` ~L197–219, and its log line) and
  `plugins/infra/plugins/launcher/bin/launch.ts:237`.
- **`gateway/main.go`:** `-listen` defaults to `loopback:9000`. A new `listenAddrs(s)` turns `loopback:P`
  into `127.0.0.1:P` plus `[::1]:P`; any other value passes through unchanged. Replace
  `srv.ListenAndServe()` with one `net.Listen` and `srv.Serve(l)` per address on the shared
  `http.Server`, so `Shutdown` closes both. A failure on `127.0.0.1` is fatal. A failure on `::1` is fatal
  on `EADDRINUSE` (someone else holds the port, the old issue in gateway/CLAUDE.md:24) and only a
  warning on `EADDRNOTAVAIL`/`EAFNOSUPPORT` (IPv6 disabled).
- **Other gateways:** `plugins/release/server/internal/preview-manager.ts:113` changes `:port` to `loopback:port`.
  `tauri/src-tauri/src/lib.rs:127,156` gets the same change, but it needs a desktop rebuild, so it can come later.
- **Docs:** `start/CLAUDE.md` ("Bind address", ~L60–64), `docs/setup.md:74`, `gateway/CLAUDE.md`
  (L9, L24, and the L218 example).
- **Tests:** new `listen.test.ts` (unset → loopback, `:P` → null, explicit hosts, malformed input);
  `listenAddrs` table tests plus a test binding both loopbacks on an ephemeral port in `gateway/`;
  `launch-spec.test.ts` checks that the argv contains `loopback:9000`.
- **Rollout:** nothing regenerates the installed launchd plist. A plain `./equin start` returns early
  when the service is already loaded. **The user runs `./equin start --force` once**, which rebuilds
  the binary, rewrites the plist and restarts launchd. Agents never run it. Optional follow-up task:
  make a non-forced `start` still rewrite the plist and print that a restart is needed.

## 3. Stable signature for the gateway (new `infra/codesign`)

A reusable signing primitive, shared with the upcoming menu-bar `equin.app` (see
`research/2026-10-24-global-menu-bar-plan.md` in att-1792796034-in8gj2, which uses ad-hoc `codesign -s -` today).

**Step 0 — spike.** Use a throwaway keychain and a scratch Go binary, never the login keychain. Pass requires:
`codesign --force --sign <sha1> --keychain <kc> --identifier dev.singularity.spike --timestamp=none`
exits 0 with no dialog; `codesign -v` passes; `codesign -d -r-` prints
`identifier "…" and certificate leaf = H"…"`; and a rebuilt, re-signed binary gives the same requirement.
Also test: re-signing a binary while it is running (does it crash the process?), and `-A` vs `set-key-partition-list` on macOS 26.

**Plugin `plugins/infra/plugins/codesign`** (`deps/` barrel for host code; check the boundary table lets
`infra/deps/build/deps` import it, otherwise use `core/`):
- `resolveSigningIdentity(): Promise<SigningIdentity | null>` returns
  `{kind: "configured" | "local", sha1, label, keychain}`, or null when not on macOS.
  1. **Configured:** `SINGULARITY_CODESIGN_IDENTITY` or `~/.singularity/codesign/identity` (a SHA-1 or exact
     common name, e.g. your "Developer ID Application: …"). Use a file or env var, not config_v2, because
     `deps install` runs without a backend. Resolve it with `security find-identity -p codesigning`
     (without `-v`, which hides untrusted certs). Missing or ambiguous → **throw**. Never fall back
     silently, since that would change the identity and drop grants.
  2. **Local (default for users without an Apple cert):** under a flock, create a keychain in
     `~/.singularity/codesign/` (0700, declared via `data-dirs`) with a random password in a 0600 file,
     a 20-year cert named "Singularity Local Code Signing" with the codeSigning extended key usage
     (`/usr/bin/openssl`; for OpenSSL 3, export the p12 with `-legacy`), `security import -T /usr/bin/codesign`,
     `set-key-partition-list -S apple-tool:,apple: -k <pw>`, and auto-lock off. The user's keychain
     search list and trust settings are never touched; the keychain is passed with `codesign --keychain`.
     A half-present state (only the keychain, or only the password file) → fail loudly and point to
     `./equin codesign reset`. A new cert means grants are lost once; document that.
- `signBinary(path, {identifier})`: unlock the keychain, `codesign --force --sign <sha1> [--keychain] --identifier <id>`
  (`--timestamp=none` for the local identity), then verify the requirement. No hardened runtime, no
  entitlements. Does nothing off macOS.
- A `check/` that warns when the cert expires within 30 days and fails when the configured identity is missing.

**Build hook:** add `then?: (ctx, built) => Promise<void>` to `build()` in
`plugins/infra/plugins/deps/plugins/build/deps/internal/build.ts`, using the same signature as the menu-bar
plan's `cargoBuild` `then`. `gateway.ts` passes
`then: (ctx, built) => signBinary(built, {identifier: "dev.singularity.gateway"})` on darwin targets. The
signing identity is **not** part of the input hash.

**Re-sign when the identity changes:** `ensureDep` skips a ready install, so `./equin start` (and the
release launcher) also re-signs idempotently after `ensureDep`, skipping when `codesign -d -r-` already
matches. That skip matters because the spike may show that re-signing the running gateway is unsafe.

**Releases:** bundles are never signed with a local identity. A release built on a Mac with a
configured Developer ID keeps that signature, so every user gets a stable identity with no setup.
Otherwise the release launcher copies the gateway to a stable path under `~/.singularity` and signs it
with that machine's identity, without touching the bundle.

**Migration:** the first signed build prompts once for each grant you still want. Old `a.out` rows
can't be removed by bundle id; delete them in System Settings, or use
`tccutil reset SystemPolicyDownloadsFolder` (document it, never run it automatically).

## 4. Agents as their own responsible process (new `packages/spawn-disclaim`)

Apply the disclaim at **agent.ts → claude**. claude is Developer-ID signed
(`com.anthropic.claude-code`, Team Q6L2SF6YDW), so prompts say "claude" and grants survive Claude
updates. Backends stay attributed to the gateway, which is right for app-level permissions.

**Step 0 — spike.** Build the helper in a scratch dir. `disclaim-exec /bin/sleep 60 &`, then
`disclaim-exec --print-responsible $!`, must print the sleep process's own pid (compare against a run
without the helper). Also check: whether `launchctl procinfo` works without root, and, end to end after
`tccutil reset AppleEvents`, that an agent's `osascript` prompt names claude. If `POSIX_SPAWN_SETEXEC`
loses the disclaim, fall back to spawn + wait with signal forwarding, and re-review the SDK's
pid/kill handling and the `pgrep -P` liveness check.

**Plugin `plugins/packages/plugins/spawn-disclaim`**, a sibling of `spawn-priority`. Which process is
responsible and how much CPU priority it gets are separate settings, so this doesn't become a new `spawnAtTier` tier.
- `native/disclaim-exec.c`: weak-imported `responsibility_spawnattrs_setdisclaim`; `posix_spawnattr_init`,
  then `setdisclaim(&a, 1)`, then `POSIX_SPAWN_SETEXEC` and `posix_spawnp` (the pid, stdio, signals and
  darwinbg priority are all kept). A missing symbol or a spawn error → stderr message and `_exit(127)`,
  which is loud because claude fails to start. A `--print-responsible [pid]` mode (via
  `responsibility_get_pid_responsible_for_pid`) is used for verification.
- `deps/internal/disclaim-exec.ts`: a `build({…})` dep copied from `plugins/packages/plugins/signal-origin/deps/internal/shim.ts`.
  Darwin targets only, `bundle: { optional: … }`. Forwarding the bundle root to backends doesn't exist
  yet, so released compositions keep prompting as gateway, with a report. Follow-up.
- `core/`: `disclaimArgv(helperPath | null, argv)` returns `[helper, …argv]` on macOS, and argv
  unchanged elsewhere or when `SINGULARITY_NO_SPAWN_DISCLAIM=1`.
- `exempt/` for `boundaries/no-platform-api`, mirroring spawn-priority.

**Wiring:**
- Backend boot calls `requestDep(disclaimExec)`, off the event loop, built once per machine.
- `startAgentProcess` (`plugins/conversations/plugins/runtime-sdk/machine/internal/agent-process.ts`)
  calls `readyNow`, waiting at most about 5 s while the helper is still installing. If it isn't ready,
  it calls `recordReport` and launches without the disclaim. The agent never fails because of this.
- Add a nullable `disclaimExec` to the launch options in `runtime-sdk/core/protocol.ts`, next to `claudeBin`.
- In `runtime-sdk/bin/agent.ts:392`, `spawnClaudeCodeProcess` spawns `disclaimArgv(...)`. Log the
  resolved `command`, and check that it is the signed native claude rather than `bun cli.js`.
- Non-interactive backend `claude -p` spawns (usage probe and similar) are left as they are.

**Tests:** argv-shape unit tests. Verification is through the spike checks above.

---

## Verification (end to end)

1. `./equin test plugins/framework/plugins/tooling/plugins/guards plugins/infra/plugins/launcher plugins/infra/plugins/codesign plugins/packages/plugins/spawn-disclaim plugins/conversations/plugins/workspace/plugins/scratch`, plus `go test ./...` in `gateway/`.
2. Replay real sessions against the guard: `./equin run plugins/framework/plugins/tooling/plugins/guards/e2e/replay-transcripts.ts --guards`. Every denial must be a real osascript or screencapture call.
3. Agent session: `osascript -e 1` is denied. After `touch .allow-macos-automation` it is allowed and the
   prompt names **claude**. Remove the file afterwards.
4. After the user runs `./equin start --force` once: `lsof -nP -iTCP:9000 -sTCP:LISTEN` shows `127.0.0.1` and
   `[::1]` only; `http://equin.localhost:9000` works; the LAN IP is refused.
5. `codesign -dvv` on the gateway shows `Identifier=dev.singularity.gateway` and a non-adhoc Authority.
   After a `.go` change and a rebuild, `codesign -d -r-` is unchanged. The Downloads grant survives a
   gateway restart.

## Open risks

- Private SPI (section 4) could disappear in a future macOS; the helper fails loudly when it does.
- The silent-keychain setup (section 3) depends on `set-key-partition-list` behaving on macOS 26; the spike decides.
- Grants are lost once when switching to signed builds, and again if the local cert is ever reset.
