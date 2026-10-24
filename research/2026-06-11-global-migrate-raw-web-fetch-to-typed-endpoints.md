# Migrate remaining raw web `/api` fetches to typed endpoints; empty the `no-raw-web-fetch` allowlist

## Context

The `endpoints/no-raw-web-fetch` ESLint rule (`plugins/infra/plugins/endpoints/lint/no-raw-web-fetch.ts`) is name-based: it flags any `fetch()`/`fetchWithRetry()` call inside a `/web/` file. The contributing plugin (`plugins/infra/plugins/endpoints/lint/index.ts`) carries an `ignores` allowlist with **22 burndown holdouts** (section `c`) that still talk to the server through raw `fetch("/api/...")` instead of the typed `fetchEndpoint`/`useEndpoint` path. These also evade the regex-based `endpoints:typed-web-fetches` check because each builds its URL in a variable / across multiple lines / via `encodeURIComponent`.

A raw web fetch bypasses the typed contract: no shared route string, no request/response validation, no centralized error reporting. The goal is to migrate every burndown holdout to the typed-endpoint client and **empty section (c) of the allowlist**, leaving only the 2 permanent transport exemptions (`read-ndjson.ts`, `use-resource.ts`) and the 2 primitive globs.

**Key finding from exploration:** almost every holdout's endpoint contract *already exists* (`defineEndpoint` in the plugin's `core/` or `shared/endpoints.ts`) and the server already uses `implement()`. The migration is overwhelmingly client-side. Only 4 contracts need a small addition, and one load-bearing client primitive needs a backward-compatible widening.

## Framework facts that shape the approach

- `implement()` (`plugins/infra/plugins/endpoints/core/implement.ts:49-65`) **surfaces a validated `query`** to handlers whenever the endpoint declares a `querySchema`. Handlers currently reading `req.url` manually can switch to typed `query` once the schema is added.
- `fetchEndpoint` (`web/internal/fetch-endpoint.ts`) interpolates params, appends `query`, JSON-encodes body, throws `EndpointError(status, body)` on non-2xx, and decodes the response via the endpoint's codec. Omits `undefined`/`null` query values (line 71) — so optional query params stay absent.
- `blob()` codec (`core/codec.ts:69-87`) decodes a binary response via `res.blob()`. Setting `response: blob()` only affects the **client**; a raw (non-`implement()`) server handler is unaffected.
- `useEndpoint` (`web/internal/use-endpoint.ts`) currently accepts only `{ query, enabled }` and **drops** `staleTime`/`refetchInterval`. → widen it (decision below).

## Decisions (confirmed with user)

1. **Widen `useEndpoint`** to pass through standard react-query options (backward-compatible). Studio sections (`staleTime: 60_000`) and allow-monitor (`refetchInterval: 3_000`) then become clean one-liners.
2. **Hybrid mutation style**: `useEndpointMutation` for components whose state maps cleanly to one `isPending`; imperative `await fetchEndpoint(...)` (preserving existing busy/toast logic) where the gating is per-item, live-state-derived, or the call site is a **module-level function** (hooks can't run there).

---

## Work plan

### A. Primitive: widen `useEndpoint`

**`plugins/infra/plugins/endpoints/web/internal/use-endpoint.ts`**

```ts
import { useQuery, type UseQueryResult, type UseQueryOptions } from "@tanstack/react-query";
import { EndpointError } from "./fetch-endpoint";
// ...
opts?: { query?: TQuery } & Omit<
  UseQueryOptions<TResponse, EndpointError, TResponse>, "queryKey" | "queryFn"
>,
): UseQueryResult<TResponse> {
  const { query, ...queryOptions } = opts ?? {};
  return useQuery({
    queryKey: ["endpoint", endpoint.route, JSON.stringify(params ?? {}), JSON.stringify(query ?? {})],
    queryFn: async ({ signal }) => { /* unchanged */ },
    ...queryOptions,            // staleTime, refetchInterval, enabled, placeholderData, ...
  });
}
```
`enabled` now flows through the spread (still works). Existing callers unchanged.

### B. Endpoint contract additions

| Endpoint (file) | Change |
| --- | --- |
| `getFileDiff` — `plugins/code-explorer/core/endpoints.ts` | add `query: z.object({ path: z.string(), base: z.string().optional(), head: z.string().optional(), from: z.string().optional() })` |
| `getCommitFiles` — `plugins/code-explorer/core/endpoints.ts` | add `query: z.object({ sha: z.string() })` |
| `resolveFile` — `plugins/code-explorer/plugins/file-resolve/shared/endpoints.ts` | add `query: z.object({ path: z.string() })` |
| `getAttachmentFile` — `plugins/infra/plugins/attachments/shared/endpoints.ts` | add `response: blob()` (import `blob` from `@plugins/infra/plugins/endpoints/core`). Safe — no existing `fetchEndpoint` caller; server handler is raw and unaffected. |

### C. Server handlers — use typed `query` (for B's new schemas)

Switch from manual `new URL(req.url).searchParams.get(...)` to the typed `query` arg now provided by `implement()`:
- `plugins/code-explorer/server/internal/file-diff-handler.ts` → `({ params, query })`, use `query.path/base/head/from`
- `plugins/code-explorer/server/internal/commit-handler.ts` → use `query.sha`
- `plugins/code-explorer/plugins/file-resolve/server/internal/resolve-handler.ts` → use `query.path`

(`file-content-handler.ts` already has a query schema and works; leave as-is — out of scope.)

### D. Web migrations — GET reads via `useEndpoint`

All studio sections: replace the `useQuery({ queryFn: fetch... })` block with `useEndpoint(<ep>, { tableName }, { staleTime: 60_000 })`. Endpoints already exist in each plugin's `shared/endpoints.ts`. Delete now-unused local row `interface`s if the schema-inferred type suffices (keep if still referenced).

| File | Replacement |
| --- | --- |
| `…/tables/plugins/indexes/web/components/indexes-section.tsx` | `useEndpoint(getTableIndexes, { tableName }, { staleTime: 60_000 })` |
| `…/columns/web/components/columns-section.tsx` | `useEndpoint(getTableColumns, …)` |
| `…/row-count/web/components/row-count-section.tsx` | `useEndpoint(getTableRowCount, …)` |
| `…/sample-rows/web/components/sample-rows-section.tsx` | `useEndpoint(getTableSampleRows, …)` |
| `…/foreign-keys/web/components/foreign-keys-section.tsx` | `useEndpoint(getTableForeignKeys, …)` |
| `…/allow-monitor/web/components/allow-monitor-chip.tsx` | `useEndpoint(getAllowFiles, { id: convId }, { refetchInterval: 3_000 })` |

### E. Web migrations — imperative reads via `fetchEndpoint` (inside existing `useEffect`)

Discriminated-union loading hooks and effect-driven panes keep their structure; only the fetch line changes.

| File | Replacement |
| --- | --- |
| `…/code/plugins/file-pane/web/use-file-content.ts` | `fetchEndpoint(getFileContent, { worktree }, { query: { path }, signal })` → `.content` |
| `…/file-pane/plugins/diff/web/use-diff-tokens.ts` (`fetchFileContent` helper) | `fetchEndpoint(getFileContent, { worktree }, { query: { path, ref } })` → `.content ?? null` |
| `…/file-pane/plugins/diff/web/use-file-diff.ts` | `fetchEndpoint(getFileDiff, { worktree }, { query: { path, base, head, from } })` → `.diff` |
| `…/commits-graph/web/use-commit-files.ts` | `fetchEndpoint(getCommitFiles, { worktree }, { query: { sha } })` |
| `plugins/debug/…/profiling/plugins/build/web/components/build-detail.tsx` | `fetchEndpoint(getBuildRunProfileByWorktree, { worktree, buildId })` |
| `plugins/debug/…/profiling/plugins/push/web/components/push-detail.tsx` | `fetchEndpoint(getPushDetail, { pushId })` |
| `…/push-profiling/web/components/push-profiling-pane.tsx` | `fetchEndpoint(getPushProfiling, {}, { query: { worktree: attemptId } })` |
| `plugins/code-explorer/plugins/file-resolve/web/internal/use-resolved-file.ts` | `fetchEndpoint(resolveFile, { worktree }, { query: { path } })` |
| `plugins/active-data/web/internal/use-active-data-binding.ts` | `set` → `fetchEndpoint(putBinding, identity, { body: { payload: next } })`; `clear` → `fetchEndpoint(deleteBinding, identity)`. Drop the `bindingPath()` helper. |
| `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web/hydrate.ts` | `const blob = await fetchEndpoint(getAttachmentFile, { id: midi.attachmentId }); const buf = await blob.arrayBuffer();` Drop the `attachmentUrl()` + raw `fetch`. |

### F. Web migrations — mutations (hybrid)

**`useEndpointMutation`** (React component, clean `isPending`):
- `…/resume/web/components/resume-button.tsx` → `useEndpointMutation(resumeConversationEndpoint)`; `mutateAsync({ params: { id: conversation.id } })`; `disabled = mutation.isPending || …`.
- `…/summary/web/components/summary-pane.tsx` → `useEndpointMutation(generateConversationSummary)` to fire + surface errors; **keep** the bespoke `pendingSince` live-state gate (it tracks the live-confirmed window, longer than the request).

**Imperative `fetchEndpoint`** — module-level functions (no hook context) OR per-item / live-derived gating; preserve existing busy/error/toast logic:
- `plugins/auth/web/connect.ts` (`disconnect`, module fn) → `fetchEndpoint(disconnect, { provider: providerId }, { body: { accountId } })`. Leave `startConnectFlow` (a `window.open` OAuth popup, **not** a fetch — the lint rule doesn't flag it).
- `plugins/conversations/plugins/conversation-category/web/internal/api.ts` (module fns) → `setCategory` → `fetchEndpoint(setConversationCategory, { conversationId }, { body: { category } })`; `reclassify` → `fetchEndpoint(classifyConversation, { conversationId })` (server returns 202 → `res.ok` → resolves).
- `…/dependencies/web/components/dependencies-button.tsx` (per-task `busy` keyed by id) → `fetchEndpoint(addTaskDependency, { id }, { body: { dependsOnTaskId } })` / `fetchEndpoint(removeTaskDependency, { id, depId })` for all 4 actions.
- `…/prompt-input/web/components/prompt-input.tsx` (`disabled` from live status) → `fetchEndpoint(postConversationTurn, { id: conversation.id }, { body: { text: current } })`.

### G. Empty the allowlist

**`plugins/infra/plugins/endpoints/lint/index.ts`** — delete all 22 entries in section `(c)` plus its `(c) BURNDOWN …` comment block. Keep section `(a)` (2 primitive globs) and section `(b)` (2 permanent: `read-ndjson.ts`, `use-resource.ts`). The rule then stays green with the burndown complete.

---

## Critical files

- Primitive: `plugins/infra/plugins/endpoints/web/internal/use-endpoint.ts`, `…/lint/index.ts`
- Contracts: `plugins/code-explorer/core/endpoints.ts`, `…/file-resolve/shared/endpoints.ts`, `plugins/infra/plugins/attachments/shared/endpoints.ts`
- Server: `plugins/code-explorer/server/internal/{file-diff,commit}-handler.ts`, `…/file-resolve/server/internal/resolve-handler.ts`
- 22 web holdouts listed in sections D–F above.

## Verification

1. `./equin build` — regenerates docs/migrations, builds web + server, restarts. Adding query schemas / a blob response changes no exported symbol names, so `plugins-doc-in-sync` should stay green (build regenerates regardless).
2. `./equin check` — must pass `eslint` (the `no-raw-web-fetch` rule now runs against the migrated files with an empty burndown list) and `endpoints:typed-web-fetches` / `endpoints:no-raw-json-handlers`.
3. `rg -n "fetch\(|fetchWithRetry\(" <each migrated file>` → zero raw matches (only `fetchEndpoint`).
4. Manual spot-checks at `http://<worktree>.localhost:9000` via `e2e/screenshot.mjs`:
   - Studio → a table detail pane: columns / indexes / FKs / row-count / sample-rows sections populate.
   - Open a conversation: code file-pane (raw + diff), commits-graph commit diff, allow-monitor chip (polls), resume button, prompt input send, dependencies add/remove, summary generate, category set/reclassify.
   - Sonata: import/hydrate a MIDI song (binary attachment path).
   - Debug → Profiling: build-detail, push-detail, push-profiling panes load.
   - Auth: disconnect an account.
5. Confirm `plugins/infra/plugins/endpoints/lint/index.ts` section (c) is empty.

## Risks / notes

- Adding required `query` params to `getFileDiff`/`getCommitFiles`/`resolveFile` makes `implement()` 400 on missing params — acceptable, the only callers always send them.
- `getAttachmentFile` gaining `response: blob()`: verified no existing `fetchEndpoint` caller; server stays a raw binary handler.
- `read-ndjson.ts` and `use-resource.ts` must **not** be migrated (permanent exemptions).
