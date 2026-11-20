# deploy

`./equin deploy converge|ship|restart` — the verbs over a deployment.
**converge** makes a host serve a composition; **ship** puts a bundle on it and
activates it behind a health gate; **restart** restarts the installed service
on the release `current` names and holds the same gate. Design:
`research/2026-07-29-global-composition-production-deployment.md` (D3 + D4).

The first command contributed as a **group**: `cli/index.ts` declares `deploy`
with `subcommands: [converge, ship, restart]` and no `run` of its own, and each
subcommand is an ordinary leaf reaching its own implementation through a lazy
`import()`. The declaration union makes "both runs and routes" a type error, so
a group cannot accidentally acquire a body.

```
cli/index.ts                    the group + its leaves (data only)    
cli/converge.ts                 the converge action
cli/ship.ts                     the ship action
cli/restart.ts                  the restart action
cli/internal/target.ts          `(composition, --server)` → everything both verbs act on
cli/internal/closure-guards.ts  converge's pre-mutation refusals
cli/internal/converge-script.ts the generated host state (+ its test)
cli/internal/secret-env.ts      the approved deploy secrets, fetched and rendered for stdin
cli/internal/activate-script.ts the generated activation (extract, swap or host restart) + health gate (+ its test)
cli/internal/restart-script.ts  the generated restart + the same health gate (+ its test)
```

**A restart is a recorded run, not a repair script.** `deploy restart` is what
the box link's `down` (the server answers SSH, equin does not run) offers as
*Restart site*: `systemctl restart` of the unit, then the ship's gate —
ready, `/api/health` naming the run id of the release `current` points at,
and that process settling (`SETTLE_GATE_SH`, shared). It converges and ships
nothing, so it has nothing to revert: a release that will not come back fails
the run with the unit's journal, and the next move is a deploy. The Deploy app
launches it as the `restart` verb (`apps/deploy/deployments`), so it lands in
the site's history like a converge or a ship.

`target.ts` is what the two verbs share, and it is not a grab-bag: both must
resolve a target the SAME way, because every refusal in it is one a half-done
deploy would otherwise discover on the host. The budgets live there together —
each bounds a different external wait, and `ACTIVATE_MS` has to exceed the
health gate's own `READY_ATTEMPTS × READY_INTERVAL_SEC` plus `SETTLE_DEADLINE_SEC`,
which is only checkable by eye if all are in one place.

**A release is live once the process that took over reports its boot settled**
(`SETTLE_GATE_SH`), not on its first ready answer — the same definition as a
local build (`build/cli/internal/stay-up.ts`). Readiness is the barrier BEFORE
the post-ready boot phases, so a release that crashes in `onReady` answers once
and is respawned: another `startedAt` answering, or no answer for the last
`SETTLE_SILENCE_SEC` when the deadline passes,
fails the gate and reverts; the same process still unsettled at the deadline
passes with a `[warn] staying up is unproven` line.

**Deploy secrets travel only on stdin.** Converge asks this checkout's backend for
the deployment's approved env (refusing, before any host mutation, while a secret is
missing, new or changed — `apps/deploy/deploy-secrets`), generates the script from the
KEYS alone, and hands the `KEY=value` lines to `runScript`'s `stdin`; the script reads
them first thing (`SECRET_ENV_SH`) and encrypts each into a systemd credential
(`SECRET_CREDENTIALS_SH`) — never into the env file. No value is in argv, the
uploaded script or the transcript. Ship's health gate then asks the running app
whether it can read every installed credential, and fails the ship if not
(`apps/deploy/deploy-secrets` CLAUDE.md, *On the box*).

**A ship swaps the backend; it restarts the host only when the host changes.**
The activate script extracts the bundle while the previous release serves, then
runs the new release's `launch swap` (`infra/launcher` § A release host): the
gateway boots the new backend beside the serving one and switches once it is
ready, so no visitor waits and the old backend drains its in-flight requests.
`current` flips after the gate passes. A release whose only host difference is
the gateway binary hands the running gateway over to its own first (`[gateway
handover]`: the gateway's keeper keeps the sockets and the backend — no request
waits), then swaps the backend. A release that changes the rest of the host
(Postgres, PgBouncer, the gateway's flags, how they start) exits 3 and gets
the old path, announced as `[host restart]`: flip, `systemctl restart`, gate — already
extracted, so the gap is ~2 s rather than the ~6 s an extract-after-stop cost.
A failed swap changes nothing; a swapped release failing the gate is swapped
back to the previous release's extraction (`<release>/extract-dir`), falling
back to a host restart on it. Extractions no process of the unit runs from are
pruned after the gate — safe for open tabs, because a release is served from
a dist of its own in the data root, never from its extraction: the release's
`launch` prepares it before its backend boots, beside one address dir that
keeps every address a tab used within a day (web-artifacts'
`served-addresses`). Design:
`research/2026-11-14-global-zero-wait-site-deploys.md`.

**Every request the edge sees is logged, bounded.** Caddy writes one JSON line
per request (protocol, status, size, full duration, client) to the install's
`edgeAccessLogPath` (`/var/log/caddy/<composition>.access.log`), rotated past
100 MB, 30 gzipped rolls, 14 days at most (`caddySite`). It is the box's only
record of what a visitor's browser asked for and when it cancelled; Caddy's
journal keeps only the responses it could not finish. Converge creates the file
caddy-owned before `caddy validate` (root) can create it root-owned, which
fails the reload with "permission denied".

**A restart never answers a visitor with a 502.** Every restart of the unit (a
host-changing ship, converge's restart gate, a crash) closes the loopback port
until the new gateway binds. Caddy holds a request whose dial is refused for
`EDGE_RESTART_HOLD_SEC` (`caddySite`) instead of answering an empty 502 — a
refused dial never reached the install, so it is sent once, not retried; a
request cut mid-flight is re-sent only for GET. Past the bound the install is
down and the 502 is the true answer. The unit stops in order (`KillMode=mixed`,
`TimeoutStopSec=RELEASE_STOP_TIMEOUT_S`): systemd signals only the
self-extractor, which forwards to the launcher, which stops the gateway (drain,
then the backend) before Postgres. And converge restarts only when the
configuration really changed: `put` stages in the script's private `$STAGE`,
never beside its target, so a no-op converge moves no directory mtime the
restart gate reads (it used to restart the site on every deploy, through the
drop-in's `.new`).

Both generated scripts send their progress to **stderr** (`exec 1>&2`): a FAILED
`sshRun` returns stderr only, and the failing run is the one whose log matters.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: `./equin deploy converge|ship|restart` — converge a host to serve a composition (run user, dirs, env, Caddy, systemd, firewall), ship release bundles to it behind a health gate, and restart its installed service behind the same gate.

<!-- AUTOGENERATED:END -->
