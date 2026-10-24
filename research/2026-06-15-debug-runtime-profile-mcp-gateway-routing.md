# Fix `get_runtime_profile` MCP tool reading a stale/orphaned backend

## Context

The `get_runtime_profile` MCP tool returns profiling data from a stale/orphaned
worktree backend rather than the live one the gateway serves. Observed:

- Repeated calls returned byte-identical `sinceMs` and span `atMs` reaching ~11 min
  of process uptime, while `/api/health` reported the live backend had started ~2
  min earlier (after a fresh `./equin build`).
- A span newly added to the live backend (`db [loader-acquire]`) was **absent**
  from the MCP output but **present** when reading the same worktree's profile via
  the gateway-served HTTP route `GET /api/debug/profiling/runtime`.

This makes the MCP profiler untrustworthy for verifying changes — it silently
reports a different process's in-memory data.

### Root cause

`get_runtime_profile` is the **only** MCP tool that reads **process-local
in-memory state**. Its handler calls `getRuntimeProfile()`
(`plugins/infra/plugins/runtime-profiler/core/recorder.ts`), which reads
module-level `aggregates` / `slowest` / `sinceMs` of *whatever Bun process
received the MCP HTTP request*. It ignores the `conversationId` the MCP layer
passes to every handler.

Every other cross-worktree tool resolves its target from `conversationId` and
reaches data by name/gateway, so they're immune:
- `query_db` (`plugins/database/plugins/query/server/internal/mcp-tools.ts`):
  `getConversation(conversationId)` → `basename(conv.worktreePath)` → opens a DB
  connection **by name**.

The MCP request itself is dialed via `.mcp.json` →
`http://${SINGULARITY_PARENT_HOST}.localhost:9000/api/mcp/...`, routed by the
gateway to that subdomain's **`w.active`** backend. But the profiler's in-process
memory belongs to a specific process *generation*. After a hot-swap the gateway
uses **alternating sockets** (`<name>.sock` ↔ `<name>.next.sock`, no rename
"promotion" — `gateway/worktree.go` `restartTargetPath()`), and an old/orphaned
backend can linger. The browser HTTP route always hits the gateway's live
`w.active`; the MCP tool read a *different* (orphaned) process's memory — hence
the missing `db [loader-acquire]` span and the frozen `sinceMs`/uptime.

Per decision: **scope is the MCP-correctness fix only.** The orphaned-process /
`.next.sock`-only gateway-hygiene condition is a separate concern that no longer
affects the profiler once this fix lands (the gateway only ever proxies to
`w.active`) — file it as an independent follow-up.

## Approach

Make `get_runtime_profile` stop reading process-local memory. Instead, resolve
the target worktree from `conversationId` (mirroring `query_db`) and fetch the
existing `GET /api/debug/profiling/runtime` endpoint **through the gateway**
(`http://<worktree>.localhost:9000`). The gateway only proxies to the live
`w.active`, so the MCP output becomes byte-identical to the browser HTTP route
and is immune to orphaned/old process generations.

This routes the tool the same way as all other cross-worktree data access, fixing
the class of bug ("MCP tool reads the request-serving process's local state")
rather than the symptom.

### Changes

**Single file:**
`plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts`

Rewrite the handler:

1. **Resolve the worktree name** from context, mirroring `query_db` exactly:
   - Accept an optional `worktree` input param (string, like `query_db`'s
     `database`) for targeting another worktree (e.g. `"singularity"` for main).
   - Otherwise `const conv = await getConversation(conversationId)` (import from
     `@plugins/tasks/plugins/tasks-core/server`); throw if unknown; use
     `basename(conv.worktreePath)`.
   - Reuse the same safety regex as `query_db`: `/^[a-zA-Z0-9_-]+$/`.
   - Update the handler signature to `async handler({ kind, limit, worktree }, { conversationId })`.

2. **Fetch the live profile through the gateway** (mirror the server-side
   gateway-fetch precedent in `plugins/auth/server/internal/get-token.ts` and
   `plugins/infra/plugins/secrets/server/internal/operations.ts` — plain `fetch`,
   no `fetchEndpoint` which is web-only):
   ```ts
   const url = `http://${worktreeName}.localhost:9000/api/debug/profiling/runtime`;
   const res = await fetch(url);
   if (!res.ok) throw new Error(`runtime profile fetch failed (${res.status}) for "${worktreeName}"`);
   const profile = runtimeProfileSchema.parse(await res.json());
   ```
   - Import `runtimeProfileSchema` from `../../shared/endpoints` (same plugin, no
     cross-plugin cycle). `.parse()` gives a typed, validated profile of the exact
     shape the existing projection already consumes.
   - **Fail loudly** on a non-ok response (per CLAUDE.md) — no fallback to local
     `getRuntimeProfile()`, which would reintroduce the bug.

3. **Keep the existing projection unchanged** — the top-N / `byParent` / `slowest`
   mapping (current lines 28–94) operates on exactly `runtimeProfileSchema`'s
   shape, so it works verbatim on the fetched `profile`. Drop the
   `getRuntimeProfile` import from `@plugins/infra/plugins/runtime-profiler/core`
   (keep the `SpanKind` type import).

4. **Update the tool `description`** to note it targets the conversation's
   worktree by default and accepts an optional `worktree` override (mirroring
   `query_db`'s wording).

No other files change. The HTTP endpoint
(`server/internal/handle-runtime-profiling.ts`) and recorder stay as-is.

### Critical files

- `plugins/debug/plugins/profiling/plugins/runtime/server/internal/mcp-tools.ts` — the only file edited.
- Reference / reuse:
  - `plugins/database/plugins/query/server/internal/mcp-tools.ts` — worktree-resolution pattern to copy (`getConversation` + `basename` + regex).
  - `plugins/auth/server/internal/get-token.ts` — server-side gateway-fetch precedent.
  - `plugins/debug/plugins/profiling/plugins/runtime/shared/endpoints.ts` — `runtimeProfileSchema` to import and parse with.

## Verification

1. `./equin build` in the worktree.
2. Add a temporary uniquely-named span to the live backend (or rely on an existing
   recent one), then compare the two data sources for **this** worktree:
   - MCP: call `get_runtime_profile` (no args).
   - HTTP: `curl http://<worktree>.localhost:9000/api/debug/profiling/runtime`.
   They must now agree (same `sinceMs`, same span set) — and `sinceMs` must reflect
   the freshly built backend's start, not an 11-min orphan.
3. Confirm cross-worktree targeting: `get_runtime_profile` with
   `worktree: "singularity"` returns main's profile; an unknown name fails loudly.
4. Reset round-trip: `POST /api/debug/profiling/runtime/reset` on the worktree,
   then `get_runtime_profile` reflects the reset `sinceMs`.
5. `./equin check` passes (type-check, boundaries, plugins-doc-in-sync).

## Follow-up (out of scope, file separately)

The orphaned worktree backend lingering after hot-swap, and the `.next.sock`-only
(no plain `.sock`) condition, are gateway-hygiene issues independent of this fix.
Once this lands, the profiler is unaffected by them, but they may indicate a real
process/socket leak in `gateway/worktree.go` (`drainAndStop` / ppid-poll / boot
`sweepStaleSockets`) worth a dedicated investigation. Recommend `add_task`.
