# agent-write-ledger

Undo what an automated browser session wrote into the user's durable data.

## The problem it solves

Some UI state is saved the moment you touch it. A DataView writes its sort,
filter and groupBy into the user's config; a prototype's option picker writes the
shared picks record. So an e2e script that clicks "Group by Kind" to check that
grouping works leaves the surface grouped for the user. It also poisons its own
next run: the baseline it reads is now the grouped state.

Every request an e2e run makes carries the agent-origin headers
([`request-origin`](../../CLAUDE.md)). A domain that writes durable files asks
this primitive to snapshot those files before an agent request overwrites them.
The e2e harness then asks for everything back, at both ends of every run.

**On main there is nothing to revert**: main refuses an agent session's writes
before they run (see [`request-origin`](../../CLAUDE.md), *Main is read-only for
agent sessions*). The ledger matters on worktree deploys, where agents may
write, and for entries an older main left behind. `POST /api/agent-writes/revert`
declares `agentWrite: "agent-control"`, so it stays callable on main for those.

## Using it (a domain)

```ts
import { defineAgentWriteLedger } from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";

const picksLedger = defineAgentWriteLedger<"picks">({
  id: "prototype-picks",            // names the file; stable, kebab-case
  label: "Prototype option picks",  // what the harness prints
  restore: async (entry) => { /* write entry.before back, re-sync caches */ },
});

// In the write path, with `writer = originOf(req)`:
picksLedger.record(writer, id, { picks: file }, "set:palette"); // BEFORE the write
writeTheFile();
picksLedger.noteComplete(writer, id);                           // AFTER it landed
```

- Call `defineAgentWriteLedger` **once, at module eval** of the owning module. A
  duplicate id throws.
- `record` and `noteComplete` do nothing unless the writer is an agent, so every
  write path can call them unconditionally.
- An entry is one opaque `key` plus a named set of absolute file paths. Capture
  **every** file the write can create, change or delete, not only the obvious
  one — config captures its origin, override and ancestor files for this reason.
- `restore` must put `entry.before` back byte for byte (a `present: false`
  snapshot means "delete it") and re-sync whatever the domain caches or pushes
  over those files. Restoring through the server, not by rewriting files from
  the harness, is what makes that re-sync deterministic.

## What a revert does

`POST /api/agent-writes/revert` takes a **required** scope — `{ scope: "source",
source }` (one session: an agent's browser session, `mcp-browser:<conversationId>`)
or `{ scope: "prefix", prefix }` (a family: the e2e harness reverts `e2e`). There
is no "revert everything": several sessions write to one deploy at once, and an
unscoped revert undoes the others' writes mid-session. It walks every registered
ledger, in the order they were defined, over the entries in scope:

- **Before** is the state before the agent's FIRST write. A second write never
  overwrites it, or the revert would restore the agent's own intermediate state.
- **After** is refreshed by each `noteComplete`. If the files on disk no longer
  match it, someone else wrote on top: the entry is reported as `diverged`, left
  alone, and dropped. Their edit wins.
- If `restore` throws, the entry is reported as `failed` and **stays** in the
  ledger, so the next revert retries it. The harness turns `failed` into a FAIL.
- Idempotent: with nothing recorded it returns three empty arrays. That is what
  lets the harness call it at the start of every run, to repair a run that was
  killed before its own revert.

`GET /api/agent-writes` lists what is pending, per ledger, plus the newest
`lastWriteAt`. The harness polls it after closing the browser, until it stops
changing, so the revert does not race a debounced write still in flight.

## Storage

One file per ledger per runtime namespace:
`state/agent-write-ledger/<namespace>/<ledger-id>.json`, rewritten whole through
a temp file and a rename, so a kill mid-write cannot leave it half-written. The
path is resolved on first use, so importing an owner module needs no runtime
namespace.

The directory sits outside every domain's own data on purpose. config_v2 copies
main's config tree into each new worktree; a ledger inside it would be inherited,
and the new worktree's first start-repair would "revert" files that are
legitimately there.

**Legacy file.** Before this primitive existed, config_v2 kept its ledger at
`<namespace>/ledger.json` in the same directory. Nothing reads that file any
more. Every run reverts at its end, so it only has entries if a run was killed
and nothing ran since; those entries are not migrated. Delete it by hand if one
is lying around.

## Why a registry and not a slot

The ledgers are only read when one of the two routes is called, which is after
the whole plugin graph has loaded. So every `defineAgentWriteLedger` call has
already run, whatever order the owners loaded in, and no load order is
load-bearing. A contribution slot would add an ordering edge that no reader
needs.

## Known limits

- **One e2e run at a time.** Concurrent e2e runs against the same deploy share
  the `e2e` prefix, so one run's end-revert can undo the other's writes mid-run.
  (An agent's browser session has a source of its own and is never touched.)
- **One source per key.** An entry carries the source of the FIRST agent write
  to its key; a key two sessions both wrote is reverted with the first one.
- **Unmarked clients are invisible.** Raw `curl`, or a script's own Node-side
  `fetch` without `agentFetch`, carries no agent-origin header, so nothing is
  recorded (see [`request-origin`](../../CLAUDE.md)).
- **Only bytes on disk.** A domain value stored elsewhere — config's
  provider-backed (secret) fields — never reaches a ledger.

Design: [`research/2026-09-16-global-shared-prototype-option-picks.md`](../../../../../../research/2026-09-16-global-shared-prototype-option-picks.md)
(§ 4), generalizing
[`research/2026-08-30-global-agent-config-write-revert-ledger.md`](../../../../../../research/2026-08-30-global-agent-config-write-revert-ledger.md).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Shared agent-write ledger: defineAgentWriteLedger lets a domain snapshot the files an agent-origin request is about to overwrite (first write wins) and put them back on revert, skipping anything a person edited since; GET /api/agent-writes and POST /api/agent-writes/revert aggregate every registered ledger for the e2e harness.
- Server:
  - Uses: `infra/endpoints.implement`
  - Exports (types):
    - `AgentWriteLedger`
    - `AgentWriteLedgerEntry`
    - `AgentWriteLedgerOptions`
    - `FileSnapshot`
  - Exports (values): `defineAgentWriteLedger`
  - Routes:
    - `GET /api/agent-writes`
    - `POST /api/agent-writes/revert`
- Core:
  - Uses: `infra/endpoints.defineEndpoint`
  - Exports (types):
    - `AgentWriteEntrySummary`
    - `AgentWriteLedgerSummary`
    - `AgentWritesRevertOutcome`
    - `AgentWritesScope`
    - `AgentWritesStatus`
  - Exports (values):
    - `agentWriteEntrySummarySchema`
    - `agentWriteLedgerSummarySchema`
    - `agentWrites`
    - `agentWritesRevertOutcomeSchema`
    - `agentWritesScopeSchema`
    - `agentWritesStatusSchema`
    - `inAgentWritesScope`
    - `revertAgentWrites`
- Cross-plugin:
  - Imported by: `apps/prototypes/files`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/ledger.ts` (debt)

<!-- AUTOGENERATED:END -->
