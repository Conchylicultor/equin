# ADR: One equin instance per user

> **Status:** Accepted (2026-07-02). Architectural decision record.
> Companion to the [communications audit](./2026-07-02-comms-audit/00-overview.md)
> (which surfaced this as an unrecorded assumption) and
> [Track 5 of the structural-fixes super-plan](./2026-07-02-global-comms-structural-fixes.md).
>
> An ADR is a point-in-time decision, not living documentation. It records
> *what was decided and why* so future proposals must either fit it or
> explicitly supersede it. It is not updated as the code evolves; a reversal is
> a new ADR.

## Context

equin's [vision](./2026-06-21-global-live-state-ivm-and-instant-client-vision.md)
(and [`CLAUDE.md`](../CLAUDE.md)) is a self-evolving, per-user app: a plugin
marketplace where **users share building blocks, and agents compose a personal
OS from them**. Nowhere in that vision is a shared, multi-tenant runtime — each
user's composition is theirs.

Yet the runtime has never written down whether it is single-tenant *by
decision* or *by accident*. The [communications audit](./2026-07-02-comms-audit/00-overview.md)
found single-user/single-machine assumptions running deep through the stack
(trust-auth Postgres, per-worktree DB forks, localhost subdomains, per-origin
leader election, host-local secrets) with **no recorded status** — so every
one reads as latent debt a future contributor might "fix" by bolting on
half-measures toward multi-tenancy. The
[sync-engine issue log](./2026-04-26-sync-engine-issues.md) put it sharply
(issue #9): *"The single-user/local assumption is baked into the absence of an
auth layer, not into a deliberate 'no-auth' mode that could be flipped."*

This ADR converts the implicit assumption into an explicit, sanctioned
decision with a **bounded** future-work surface, so the couplings below are
understood as *load-bearing simplifications we chose*, not accidents to be
undone piecemeal.

## Decision

**equin runs as exactly one instance per user.** Concretely:

1. **The marketplace shares plugins, not runtime.** Users contribute and
   install building blocks (plugins, compositions); they do **not** share a
   server, a database, or a live-state fabric. Each user runs their own
   instance over their own data.
2. **One user ⇒ one trusted principal.** Within an instance there is a single
   human owner. Every request, subscription, job, and DB connection is that
   owner's. There is no notion of "other users" to isolate *inside* an
   instance.
3. **Multi-device access = an authenticated gateway to your own instance** —
   not multiple users on one instance. The future story for "reach my
   equin from my phone" is *session auth + TLS at the gateway* fronting
   the same single-owner runtime (see Future work). The number of *devices*
   may grow; the number of *tenants per instance* stays one.
4. **Multi-tenancy is a non-goal.** Serving mutually-distrusting users from one
   runtime is explicitly out of scope. A future need for it is a *new
   deployment model* that must supersede this ADR, not an incremental patch to
   this one.

## Couplings this sanctions

These are the concrete single-owner simplifications the codebase relies on.
Each is **correct under this ADR** and should not be treated as a bug. (Audit
cross-references in brackets.)

| Coupling | Where | Why it's fine under one-instance-per-user |
|---|---|---|
| **Trust-auth Postgres** — the embedded cluster runs with no per-user roles/passwords; any local process on the socket is the owner. | `plugins/database/plugins/embedded` [[02](./2026-07-02-comms-audit/02-database-layer.md)] | There is one principal; DB-level user isolation would protect the owner from themselves. |
| **Per-worktree DB forks** — every worktree gets a full `pg_dump`/restore fork of the owner's main DB. | `plugins/database/plugins/fork`, `plugins/database/plugins/admin` [[02](./2026-07-02-comms-audit/02-database-layer.md)] | All forks hold one owner's data; a fork is an agent's scratch copy, not a tenant boundary. |
| **`<name>.localhost:9000` subdomains** — worktrees are addressed by unauthenticated localhost subdomains through the gateway. | `gateway/`, `plugins/infra/plugins/worktree` [[01](./2026-07-02-comms-audit/01-topology-and-transport.md)] | Loopback is reachable only from the owner's machine; no network principal to authenticate. |
| **Unix-domain-socket backends** — backends have no TCP port; the gateway dials `~/.singularity/sockets/<name>.sock` directly. | `gateway/`, `plugins/infra/plugins/launcher` [[01](./2026-07-02-comms-audit/01-topology-and-transport.md)] | Filesystem permissions are the access boundary; that is the owner's account. |
| **Per-origin leader election** — one tab per browser origin owns the sockets via `navigator.locks`; followers relay over `BroadcastChannel`. | `plugins/primitives/plugins/networking` [[04](./2026-07-02-comms-audit/04-live-state.md)] | Election de-dupes *one user's* tabs; it is not, and need not be, a cross-user boundary. |
| **Host-local secrets** — OAuth tokens / secrets live in one AES-GCM blob with the master key in the host OS keychain, served by a singleton central backend. | `plugins/infra/plugins/secrets`, `plugins/auth` [[07](./2026-07-02-comms-audit/07-side-channels.md)] | One keychain, one owner; the central process is shared across *the owner's* worktrees, not across users. |
| **Path-prefix central routing** — `~/.singularity/central-routes.json` exposes central endpoints (incl. OAuth callbacks) on any host with no per-caller auth. | `plugins/framework/plugins/central-core` [[01](./2026-07-02-comms-audit/01-topology-and-transport.md)] | Required for bare-`localhost` OAuth callbacks; the only caller is the owner's browser. |
| **No caller identity on the live-state socket** — `WsData` carries only the upgrade path; a subscription has no principal attached. | `plugins/framework/plugins/resource-runtime` [[04](./2026-07-02-comms-audit/04-live-state.md)] | Every subscriber is the owner. The subscription-authorization seam below makes this explicit rather than silent. |

## Consequences

- **Positive.** The whole stack skips per-request auth, row-level security,
  tenant scoping, and cross-user isolation — a large, permanent simplification
  that is now a *documented choice*, not a gap. Reviewers can reject
  multi-tenant half-measures by citing this ADR.
- **Negative / accepted.** Reaching an instance from another device is not
  possible until the gateway grows session auth + TLS (below). An instance is
  as trustworthy as the host account it runs under.
- **Boundary hygiene (done in this change):** a deferred, typed
  **subscription-authorization seam** now exists on the live-state resource
  path so the "no auth" state is an *explicit, single implementation of an
  authorization decision* rather than the absence of one:
  - `ServerResourceOptions.authorize?(params) => boolean | Promise<boolean>`
    on `defineResource`
    (`plugins/framework/plugins/resource-runtime/core/runtime.ts`). Called on
    the subscribe path **before** any side effect (refcount bump,
    `onFirstSubscribe`, loader read); a falsy result refuses the subscription
    with a `sub-error` (`reason: "unauthorized"`). A throwing `authorize` fails
    **closed**.
  - **No resource declares `authorize` today** — under this ADR the sole owner
    is always allowed, so the hook is absent everywhere and the sub path is
    byte-identical to before. The seam exists purely so a future
    multi-device/authenticated deployment has a typed place to enforce
    per-subscription access without reshaping the subscribe handler. Widening
    the callback later with a caller-context argument (identity stashed on the
    socket at upgrade time) is a non-breaking additive change.

## Future work (not scheduled here)

- **Gateway session auth + TLS** is the *single* work item that a multi-device
  ("reach my own instance remotely") future requires. It fronts the same
  single-owner runtime with an authenticated session and encrypted transport;
  it does **not** introduce multi-tenancy. Only start it when remote access
  becomes a committed goal.
- Populating the `authorize` seam and threading a caller context through
  `WsData` is downstream of that item — do it *with* gateway auth, not before
  (an auth hook we never populate is noise, per the
  [live-state v3 design](./2026-04-15-global-sse-lifecycle-mental-model-v3.md) §2).

## Re-evaluation trigger

Revisit this ADR only if **remote/multi-device access to an instance becomes a
committed goal** (→ do the gateway session-auth + TLS item above, still
single-tenant), or if a **genuine multi-tenant requirement** appears (→ a new
ADR that explicitly supersedes this one; it is a different deployment model,
not a patch). Absent one of those triggers, the couplings above are settled and
not open questions.

## Links

- [Communications audit — overview](./2026-07-02-comms-audit/00-overview.md)
  and its [known-gaps list](./2026-07-02-comms-audit/08-api-catalog.md#4-known-gaps--current-frontier-honest-edges-of-the-system).
- [Structural-fixes super-plan](./2026-07-02-global-comms-structural-fixes.md) (Track 5).
- [IVM / instant-client vision](./2026-06-21-global-live-state-ivm-and-instant-client-vision.md).
- [Sync-engine issue log](./2026-04-26-sync-engine-issues.md) (issue #9, the original framing).
- [Live-state v3 mental model](./2026-04-15-global-sse-lifecycle-mental-model-v3.md) (§2, the deferred `authorize` note).
