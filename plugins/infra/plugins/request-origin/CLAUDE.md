# request-origin

Who caused a request, and the durable writes it causes.

## The signal

An automated browser session stamps two headers on every request it issues.
`withBrowser` sets them on the browser CONTEXT, so they cover the SPA's own
`fetch` calls too — one edit marks every e2e script, every future one, and every
ad-hoc `screenshot.ts --click` drive, with nothing to opt into.

(`<prefix>` is `LEGACY_IDS.headerPrefix`: a tab open across a deploy keeps sending the old spelling.)

```
<prefix>origin: agent
<prefix>origin-source: e2e:runs-surface
```

Read them with `originOf(req)`; send them with `agentOriginHeaders(source)`. A
write with no request behind it (a job, boot propagation, a CLI verb) spells
itself `systemOrigin("…")`.

## Why this plugin exists

The headers were written out independently in three places — the harness, the
pages agent-origin create-hook, and prose. A third consumer (config_v2's
agent-write ledger) made that a "these must agree" invariant with nothing
enforcing it. This is the one spelling, and `originOf` is the one reading, so a
consumer cannot classify provenance slightly differently from its neighbour.

## Main is read-only for agent sessions

On main's backend, a write (POST / PUT / PATCH / DELETE) whose request reads as
`agent` here is refused with a `403` before its handler runs — unless its
endpoint declares `agentWrite` (`"telemetry"`: logs, latency samples, slow ops,
boot traces, reports; `"agent-control"`: the agent-write revert). The gate lives
in the endpoints primitive (`endpointHandler` in `infra/endpoints/core`, decided
once per route from `isMain()`), and server-core's `HttpRoutes` type admits only
endpoint-built handlers on a write route, so no raw handler can skip it.
Worktree deploys are unchanged. Design:
[`research/2026-10-22-global-main-read-only-for-agent-sessions.md`](../../../../research/2026-10-22-global-main-read-only-for-agent-sessions.md).

`UNREVERTED_WRITE_HEADER` (`<prefix>unreverted-write`) is the third
header: `fetchEndpoint` stamps it on every write to an endpoint that does not
declare `agentReverted` — "this request records nothing an agent-write revert
undoes". The agent browser's write drain does not wait for such a request
before reverting. `originOf` carries it as the agent arm's `claimsUnreverted`,
and the agent-write ledger refuses (throws) to record a write that made the
claim, so a missing `agentReverted` is a loud failure, never a write the revert
silently missed. Main's write gate reads the endpoint definition, never a
header.

## Consumers

- **`apps/pages/agent-origin`** stamps a marker on every page an agent created,
  segregates them into the Pages sidebar's Scratch section, and sweeps them
  after 24h.
  [`research/2026-07-29-global-agent-origin-provenance-for-pages.md`](../../../../research/2026-07-29-global-agent-origin-provenance-for-pages.md)
- **[`agent-write-ledger`](plugins/agent-write-ledger/CLAUDE.md)** (sub-plugin)
  snapshots the pre-write bytes of whatever an agent-origin request overwrites,
  one ledger per domain, so the e2e harness can restore them at both ends of a
  run. Its ledgers:
  - **`config_v2`** — every config document (`Config documents`).
    [`research/2026-08-30-global-agent-config-write-revert-ledger.md`](../../../../research/2026-08-30-global-agent-config-write-revert-ledger.md)
  - **`apps/prototypes/files`** — each prototype's shared option picks
    (`Prototype option picks`).
    [`research/2026-09-16-global-shared-prototype-option-picks.md`](../../../../research/2026-09-16-global-shared-prototype-option-picks.md)

## Known limits

- **Raw `curl` is unmarked.** Nothing can mark it; the harness is the dominant
  path and this is stated rather than papered over.
- **The main write gate trusts the headers it reads.** An unmarked client (raw
  `curl`, or page JS that strips or overrides the headers) is a user to it and
  may write to main. Accepted: the gate keeps an automated session from writing
  to main by accident, it is not a security boundary.
- **A script's own Node-side `fetch` is not covered by the browser context.**
  That is a real hole with a silent failure mode, so it has its own remedy and
  its own rule: `agentFetch` in the e2e harness, enforced by
  `agent-origin-safety/no-unmarked-app-fetch`.

## Not the principal

Provenance (`user` / `agent`) is a different question from **who may call at
all** — the principal (`owner` / `anonymous`) the gateway stamps on every
request and the socket hosts gate every route on
([`framework/principal`](../../../framework/plugins/principal/CLAUDE.md)).
An agent session's browser is same-origin, so it is the owner; this plugin then
says which owner-side actor wrote. The two stay separate for now — the agent
gate is an accident guard on main, the principal is a security boundary — and
fold together in Hosted, where an agent becomes a principal of its own
(`research/2026-10-28-global-http-edge-principal.md`).

## Leaf by contract

String literals and one `Request` header read — no `node:*`, no db. That is what
lets the `e2e` runtime (whose boundary grants `core` barrels only) import the
same module the server does. Never add an import that breaks it. (This is about
this plugin's own `core`; the ledger sub-plugin is a separate plugin with its
own server half.)

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Who caused a request: the two provenance headers an automated browser session stamps on every request it issues, the WriteOrigin type a durable write records, and the single reading of those headers. A leaf — string literals and one Request read, no node:*, no db — so the e2e harness that SETS the headers and the server plugins that ACT on them share one spelling.
- Core:
  - Uses: `framework/product-name.LEGACY_IDS`
  - Exports (types): `WriteOrigin`
  - Exports (values):
    - `AGENT_ORIGIN`
    - `agentOriginHeaders`
    - `ORIGIN_HEADER`
    - `ORIGIN_SOURCE_HEADER`
    - `originOf`
    - `systemOrigin`
    - `UNREVERTED_WRITE_HEADER`
- Cross-plugin:
  - Imported by: `infra/endpoints`
- Sub-plugins:
  - **`agent-write-ledger`** — Shared agent-write ledger: defineAgentWriteLedger lets a domain snapshot the files an agent-origin request is about to overwrite (first write wins) and put them back on revert, skipping anything a…

<!-- AUTOGENERATED:END -->
