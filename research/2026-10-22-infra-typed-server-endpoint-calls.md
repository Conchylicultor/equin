# Typed server-side endpoint calls

## Context

The browser calls endpoints through `fetchEndpoint` (`infra/endpoints/web`), which
derives URL, method, body encoding and the decoded answer from the endpoint's own
`defineEndpoint` contract. Server / central / machine / cli code had nothing like it:
each caller of another runtime's endpoint hand-built the URL, sent a raw `fetch`, and
read the reply with `res.json() as T`. When 772683b57f made `secretsSet` /
`secretsDelete` answer 204, the secrets client kept parsing `{ ok: true }` and every
`setSecret` threw `Unexpected end of JSON input` (patched in 430b4c5eea). Nothing
connected the caller to the contract, so tsc could not see the drift.

Goal: a caller of one of our endpoints derives everything from the contract (a
contract change is a tsc error at the caller), and a new hand-rolled call is a lint
error.

## Design

1. **One fetch-free request core in `endpoints/core`** (`core/request.ts`) and the
   off-page client in `endpoints/server` (`server/internal/call-endpoint.ts`) — never
   in `core/`, which a page can load: a page reaches a server only through its
   subtree's transport (the sealed demo scope):
   - `endpointRequest(endpoint, params, opts)` → `{ path, init }`: interpolated path,
     query string, codec-encoded body + content type, `AGENT_WRITE_HEADER` stamp,
     caller headers / signal / keepalive.
   - `readEndpointResponse(endpoint, res)`: non-2xx → `EndpointError` (or the
     `EndpointUnsupportedError` / `EndpointAgentWriteRefusedError` refinements; body
     read once as text, upgraded to JSON); 2xx → decoded through the response codec,
     `void` for none.
   - `callEndpoint(endpoint, params, { origin, …opts })`: the two around a global
     `fetch` against an absolute origin (`http://localhost:9000` for central,
     `namespaceUrl(ns)` for a backend). Returns `Answer<TResponse>`, so the body,
     params, query and answer types all come from the contract.
   - The error classes move from `web/internal/fetch-endpoint.ts` to
     `core/endpoint-error.ts` (one class for both runtimes); the web barrel keeps
     exporting them from there, so no web consumer changes.
2. **The web fetcher (`useFetchEndpoint` / `fetchEndpointOver`) is rebuilt on the same core** (transport + `endpointErrorSink`
   reporting + `MachineResult` stay web-only), so the two clients cannot diverge.
3. **Migrate every hand-rolled call site** (inventory below) to `callEndpoint`.
   Per-site policy (retry, offline mapping, timeouts) stays at the site, expressed
   over `TypeError` (unreachable) and `EndpointError.status`.
4. **Lint `endpoints/no-raw-endpoint-call`** — outside `web/`, `e2e/` and tests, a
   string beginning with `/api/` passed as a call argument, or a `fetch` whose URL
   is built from an endpoint's `.path` / `extractPath(…)`, is an error pointing at
   `callEndpoint`. Genuine exceptions are inline-disabled with a reason.
5. `infra/health`'s endpoints move from `shared/` to a new `core/` barrel: the CLI
   and the launcher call them.

## Inventory

| Site | Endpoint | Outcome |
| --- | --- | --- |
| `infra/secrets/server/internal/operations.ts` | `secrets*` | `callEndpoint`; 502–504 / gateway-404 → `SecretsMainOfflineError` |
| `auth/server/internal/get-token.ts` | `getToken` | `callEndpoint`; same offline mapping |
| `debug/queue-health/machine/internal/mcp-tool.ts` | `queueHealthSummaryEndpoint` | `callEndpoint` |
| `debug/profiling/runtime/server/internal/mcp-tools.ts` | `getRuntimeProfile` | stays raw (stale-profile backfill runs before the schema) — inline-disabled with reason; path from the endpoint |
| `debug/profiling/boot-bench/server/internal/mcp-tools.ts` | `bootBenchRun` | `callEndpoint` |
| `debug/sentinel/server/internal/fleet-flights.ts` | `getFlightWindow` | stays loose on purpose (fleet on mixed code) — inline-disabled with reason |
| `cli/db/cli/fork.ts` | `getForkExclusions` | `callEndpoint` |
| `cli/deploy/cli/internal/target.ts` | `listDeployments`, `createDeployment` | the file's private `callEndpoint` replaced by the core one |
| `infra/mcp/browser/shared/revert.ts` | `revertAgentWrites` | `shared/` cannot import `server/`: composes `endpointRequest` + its sanctioned `fetch` + `readEndpointResponse` |
| `conversations/compaction-context/shared/client.ts` | `compactionContext` | stays raw: a Claude hook process that must not load zod / the endpoints barrel — inline-disabled with reason |
| `infra/launcher/server/internal/boot.ts` | `getHealthReady` | `callEndpoint` |
| `cli/build/cli/internal/deploy-namespace.ts` (×2) | `getHealth` | `callEndpoint` |

Out of scope: `/gateway/*` (Go gateway, no contract), the agent-browser host's unix
socket RPC (not a `defineEndpoint`), third-party APIs, e2e scripts (`agentFetch`).

## Verification

- `./singularity test plugins/infra/plugins/endpoints` (new `call-endpoint.test.ts`:
  void/204, schema decode, error refinement, query/body encoding).
- `./singularity check type-check` + `eslint`; the lint flags a reintroduced
  `post("/api/secrets/set", …)`.
- `./singularity build`, then add/remove a secret path (Settings → Accounts) on the
  worktree build.
