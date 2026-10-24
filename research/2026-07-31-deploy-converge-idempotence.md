# Converge is a no-op the second time

**Status:** plan
**Touches:** `plugins/framework/plugins/cli/bin/commands/deploy.ts` (D3's converge script)
**Design it amends:** [`2026-07-29-global-composition-production-deployment.md`](./2026-07-29-global-composition-production-deployment.md) §D3

## Context

`./equin deploy converge <c> --server <s>` restarts a live install on every run,
even when the run changes nothing. Observed on the equin.ai `website` install: every step
reported `[=]`, followed by `[~] restarted equin@website.service to pick up
/srv/equin/website/env`. The site goes down for the length of a restart each time.

This contradicts D3's own acceptance criterion — *"Converge run twice against a bare
Ubuntu image is a no-op the second time"* — and it makes converge unusable as the "re-run
to repair drift" tool its `--help` advertises: repairing a hostname typo costs a restart
you did not ask for, and inspecting a host costs one too.

### Root cause, and why it is not a one-line fix

The restart gate (`deploy.ts:836-843`) tests the wrong proposition:

```sh
if systemctl is-active --quiet "$UNIT"; then   # "is it running" — true on every healthy install
  systemctl restart "$UNIT"
```

The intent in its own comment is "the env file may have just changed". But there is no
signal in the script that could answer that, because **the steps above it write
unconditionally and report `[=]` as a hardcoded string**:

| step | line | writes | reports |
| --- | --- | --- | --- |
| 3 `env` | `deploy.ts:726-735` | always (`.new` → `chmod` → `mv -f`) | `[=]` always |
| 4b apt source list | `deploy.ts:768-770` | always | (silent) |
| 4b Caddy site | `deploy.ts:781-785` | always | `[=]` always |
| 4b root `Caddyfile` | `deploy.ts:800-807` | always, then `reload caddy` | `[=]` always |
| 5 unit template | `deploy.ts:816-822` | always, then `daemon-reload` | `[=]` always |
| 6 `ufw` | `deploy.ts:829-833` | always re-applies | `[=]` always |

So the observed `[=] $ENV_FILE` was **asserted, not derived** — the script cannot
distinguish "already correct" from "I just replaced it with identical bytes". Every file's
mtime is bumped on every run. Any restart gate built on top of that inherits the same
blindness, which is why the fix is one change to how converge writes files, not a patch to
step 7.

## The change

**Principle: no converge step may claim `[=]` without having compared, and no step may act
without having found a difference.** Two pieces.

### 1. `put` — the only way a generated file lands on the host

One helper at the top of the generated script, used by every file write. It stages to
`$1.new` (as today), applies mode/owner, then replaces the target **only when the content
differs**; mode and owner are re-applied either way, so a hand-`chmod`ded file still
converges back without counting as a content change.

```sh
# Returns 0 when the file changed, 1 when the host was already correct.
put() {
  target=$1 mode=$2 owner=$3
  chmod "$mode" "$target.new"
  [ "$owner" = "-" ] || chown "$owner" "$target.new"
  if cmp -s "$target.new" "$target" 2>/dev/null; then
    rm -f "$target.new"
    chmod "$mode" "$target"
    [ "$owner" = "-" ] || chown "$owner" "$target"
    return 1
  fi
  mv -f "$target.new" "$target"
  return 0
}
```

Every call site becomes `if put …; then <act> ; echo "[~] …"; else echo "[=] …"; fi`, which
makes the report derived by construction. The atomic-replace property of today's `.new` +
`mv -f` is unchanged; a missing target makes `cmp` fail, i.e. "changed", which is correct
on a bare host.

Consequences at the call sites:

- **`env`, apt source list, Caddy site, root `Caddyfile`, unit template** — all route
  through `put`.
- **`daemon-reload`** fires only when the unit file changed.
- **`systemctl reload caddy`** fires only when the site or root `Caddyfile` changed (or
  caddy is not yet active). `caddy validate` stays unconditional — it is a guard, not an
  action.
- **`systemctl enable`** is gated on `systemctl is-enabled --quiet` so its "Created
  symlink" noise appears only on the run that enables it.
- **`ufw`** reads `ufw status verbose` once and skips the four commands when the defaults
  and the `<sshPort>,80,443/tcp` rule are already in place. Re-applying is not
  service-disruptive, but claiming `[=]` while doing it is the same dishonesty as above.
- `cmp` comes from `diffutils`; add it to the guarded package list in step 4a and move
  that step **ahead** of the `env` write so the helper's one dependency is present before
  its first use. (It is on every Ubuntu image today — this just stops that being an
  assumption.)
- Step 2's `install -d` stays unconditional: it re-applies owner/mode and changes nothing
  observable when they already match, so its `[=]` is already true.

### 2. The restart gate: is the running process older than its configuration?

```sh
# ── 7. Restart only when the RUNNING process predates its configuration.
newest=0
for f in "$ENV_FILE" "$UNIT_PATH"; do
  m=$(stat -c %Y "$f")
  if [ "$m" -gt "$newest" ]; then newest=$m; fi     # an `&&` here would trip `set -e`
done
if ! systemctl is-active --quiet "$UNIT"; then
  echo "[=] $UNIT is enabled but not running — nothing shipped yet"
else
  mono=$(systemctl show -p ExecMainStartTimestampMonotonic --value "$UNIT")
  btime=$(awk '/^btime /{print $2}' /proc/stat)
  if [ -z "$mono" ] || [ "$mono" = "0" ]; then
    started=0                                        # cannot prove it is current → restart
  else
    started=$(( btime + mono / 1000000 ))
  fi
  if [ "$newest" -gt "$started" ]; then
    systemctl restart "$UNIT"
    echo "[~] restarted $UNIT — its configuration is newer than the running process"
  else
    echo "[=] $UNIT is current with $ENV_FILE and $UNIT_PATH"
  fi
fi
```

Why a state comparison rather than a "did this run change something" flag:

- **It self-heals.** A converge that wrote a new `env` and then died (ssh deadline, dropped
  link) before restarting leaves an install serving the old port. A `changed` flag would
  see nothing to do on the next run and leave that drift permanent — the same class of bug,
  inverted. The mtime comparison repairs it.
- **It composes with `ship`.** Ship restarts the unit (`deploy.ts:1119`), so the process is
  newer than both files and a converge after a ship correctly does nothing.
- **One gate covers both files.** A changed unit template needs the same restart as a
  changed `env`, and `daemon-reload` alone does not give it to a running service.

Wall-clock start time is computed from `btime + ExecMainStartTimestampMonotonic`
deliberately: `ExecMainStartTimestamp` is a formatted string whose weekday/month names
follow the client's locale, and parsing it with `date -d` would make the gate
locale-dependent. Precision is bounded by `btime`'s one second; the comparison is strictly
`>`, so a config written in the *same second* as the restart is treated as current — a
one-second window in which a crashed converge would not be repaired until the next config
change, and the alternative (`>=`) would restart on every run for installs whose write and
restart landed in the same second.

## Testability — the reason this is worth a small refactor

`convergeScript` is a ~200-line shell template that is only ever executed on a remote host,
15 minutes and a 100MB round trip away. A typo in it is discovered in production. So:

- Move `convergeScript` and its private helpers (`sq`, `unitTemplate`, `caddySite`) into
  **`bin/commands/internal/converge-script.ts`**, following the existing pattern in that
  directory (`compose-serve.ts`, `dist-publish.ts` — each with a colocated `.test.ts`).
  `deploy.ts` keeps importing `sq` from there for `activateScript`.
- Export the two load-bearing blocks as their own constants embedded into the script —
  `PUT_HELPER_SH` and `RESTART_GATE_SH` — so the tests exercise the exact text that ships
  rather than a copy.
- New `internal/converge-script.test.ts` (`bun:test`):
  - `bash -n` the generated script for both branches (hostnames present / absent) — a
    syntax check that today only a live host performs.
  - Source `PUT_HELPER_SH` in a real `bash` against a temp dir and assert: first write
    creates the file and returns 0; an identical second write returns 1 **and leaves the
    mtime untouched** (the property the restart gate depends on); a differing write returns
    0 and replaces; a drifted mode is repaired on the unchanged path.
  - Run `RESTART_GATE_SH` against a stubbed `systemctl` / `stat` and a fake `/proc/stat`,
    asserting the whole decision table: not running, process newer than config, newer
    `env`, newer unit template, same-second write, and an unreadable start time. The stubs
    return fixed numbers because what is under test is the decision, not GNU stat's flag
    spelling. `PROC_STAT` is defaulted (`${PROC_STAT:-/proc/stat}`) purely as that seam.
  - A structural assertion that no `mv -f "$X.new"` survives outside `put` — the way a
    future step would silently reintroduce the mtime bump the gate reads.

## Files

- `plugins/framework/plugins/cli/bin/commands/deploy.ts` — remove the extracted functions;
  import them from `internal/`.
- `plugins/framework/plugins/cli/bin/commands/internal/converge-script.ts` — new; the
  script builder with the `put` helper and the seven now-conditional steps.
- `plugins/framework/plugins/cli/bin/commands/internal/converge-script.test.ts` — new.
- `plugins/apps/plugins/deploy/plugins/deployments/CLAUDE.md` — one line under the CLI
  section: converge's idempotence contract (what makes a re-run a no-op, and what makes it
  restart).

## Verification

1. `bun test plugins/framework/plugins/cli/bin/commands/internal/converge-script.test.ts`
2. `./equin check` (type-check + lint) and `./equin build`.
3. **The acceptance criterion needs a real host.** Against the equin.ai `website`
   deployment:

   ```bash
   ssh … systemctl show -p ExecMainStartTimestamp --value equin@website.service   # note it
   ./equin deploy converge website --server <server>   # run 1: restarts ONCE (new env/unit bytes may land)
   ./equin deploy converge website --server <server>   # run 2: must print no [~] at all
   ssh … systemctl show -p ExecMainStartTimestamp --value equin@website.service   # unchanged since run 1
   ```

   Pass = run 2 is all `[=]`, and the start timestamp is identical before and after it.
   This is a live production install, so I will not run it without you saying so — tell me
   to and I will, or run it yourself and paste the output.
