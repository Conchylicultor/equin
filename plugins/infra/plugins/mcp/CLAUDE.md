# mcp

HTTP MCP server at `POST /api/mcp/:conversationId`. Every request builds a
fresh, stateless `McpServer`; the conversation id from the URL is the context
(`McpToolContext`) handed to every contribution.

## Two halves

- `server/` — the contribution API only (`Mcp.tool` / `Mcp.instructions` /
  `Mcp.scope`, the types, the in-process registry). SDK-free, so a plugin that
  contributes a tool or a section stays portable (a browser host registers its
  contributions into a registry nothing serves).
- `machine/` — everything that answers agents: the `POST /api/mcp/:conversationId`
  route (`@modelcontextprotocol/sdk`), the `mcp.catalog` and `mcp.health` values.
  All three are declared `needsMachine` — agents run on the computer — so the
  SDK (and ajv) never reach a browser host's bundle, and a host without the
  computer shows Debug → MCP tools and the health row as not available here.

## Contributing

Both factories return a `Registration` token that goes in the plugin's server
`register: [...]` array. Duplicate names/ids throw at register time.

- `Mcp.tool({ name, description, inputSchema, when?, handler })` — a tool the
  agent can call. `when(ctx)` gates it per conversation: when false the tool is
  not registered on that request's server, so it is absent from `tools/list`
  and a call to it is an unknown-tool error (the handler never runs). It runs
  on **every** MCP request (all gates in parallel), so keep it a cheap lookup;
  a `when` that throws hides only that tool (see *Failure isolation*).
  Omitted: visible everywhere.
  Optional `liveDescription(ctx)` appends a LIVE section to the fixed
  `description` (after a blank line), rendered only for a `tools/list` request
  — i.e. the data as of when the client listed the tools, typically at connect.
  For facts held in the database that an agent needs while using the tool (a
  vocabulary to pick from). `null` adds nothing; a throw is isolated (see
  *Failure isolation*).
- `profiles?: readonly string[]` on a tool reserves it for those scopes (scratch
  profiles): never listed in the default scope, listed for a profile only when
  that profile's allowlist also names it.
- `Mcp.scope(resolver)` — THE one resolver of a conversation's scope
  (`{kind:"default"}` or `{kind:"profile", profile, tools}`), registered by
  `conversations/workspace/scratch` (inverted so this plugin knows nothing of
  conversations). A profile scope sees exactly its `tools` (an unknown or
  foreign-reserved name throws) and gets no server instructions; `when` still
  applies on top. Pure filter: `machine/internal/scope.ts`.
- `Mcp.instructions({ id, render })` — a section of the server instructions.
  `render(ctx)` returns the section text, or `null` to contribute nothing for
  that conversation.

## Catalog

`mcp.catalog` (core, a `liveValue` fixed for the process) lists every tool,
instructions section and the scope resolver with the plugin that declared each
(recorded via `registeringPlugin()` at register time). Each tool's input schema
is read off a real `tools/list` over an in-memory client (`machine/internal/catalog.ts`),
through the same `mountTool` the request path uses — so it is exactly what
agents receive. Shown by Debug → MCP tools (`debug/mcp-tools`).

## Server instructions

MCP clients receive server instructions once, in the `initialize` result, so a
client sees them at connect (Claude Code connects once per conversation).

- Rendering happens **only** when the request body is an `initialize` call (a
  single message, or a batch containing one). Tool calls, `tools/list` and every
  other request render nothing and cost what they did before.
- All contributions render in parallel; the non-null results join in **id
  order**, separated by blank lines. With nothing left the field is omitted.
- A `render` that throws fails only its own section (see *Failure isolation*).
- Clients may truncate long instructions. Keep sections short and point at
  longer material instead of inlining it.

## Failure isolation

Every per-connection contribution callback — an instructions `render`, a
`liveDescription`, a `when` gate — runs through `runContribution`
(`machine/internal/isolate.ts`): a throw stays that contribution's failure, never
the connection's. It is reported (server log + a `crash` report via
server-core's `reportServerError`) and rendered where the contribution would
have been:

- instructions section → a "section unavailable" notice naming the error, so the
  agent knows guidance is missing;
- live description → the fixed description plus the same kind of notice;
- `when` → the tool is hidden for that request (fail closed: a gate that cannot
  answer never grants).

Why not fail the whole request: these are independent contributions from
unrelated plugins. Failing the connect for one of them (as it did until
2026-10-28) let a single broken section — tree-digest's — take down every equin
tool for every agent for over an hour, including `exit_clean` / `flag_raise`, the
very tools an agent would use to report it. Loud means *reported and visible*,
not *blast radius of everything*. The scope resolver stays global: there is one,
and without it no tool set can be computed.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The MCP contribution API, SDK-free: Mcp.tool / Mcp.instructions / Mcp.scope register a tool, a server-instructions section or THE scope resolver into the in-process registry the desktop half (machine/) serves over HTTP — so a plugin contributing to the MCP server stays portable.
- Load-bearing: yes
- Server:
  - Contributes:
    - `resource.declare` "mcp.catalog"
    - `resource.declare` "mcp.health"
  - Exports (types):
    - `McpInstructions`
    - `McpScope`
    - `McpScopeResolver`
    - `McpTool`
    - `McpToolCallContext`
    - `McpToolContext`
    - `McpToolResult`
  - Exports (values): `Mcp`
  - Resources:
    - `mcp.catalog` (push, fixed, whole: every Mcp.tool the code registers — fixed for the process, a hundred or so, whole: every Mcp.instructions section the code registers — fixed for the process, a handful, whole: the scratch profiles a tool is reserved for — one or two, whole: one JSON Schema object's top-level keywords (type, properties, required, …) — a handful)
    - `mcp.health` (push, notified, capped: MCP_HEALTH_MAX_DEGRADED)
- Machine:
  - Uses:
    - `infra/endpoints.machineHandler`
    - `network/live.serveValue`
  - Routes: `POST /api/mcp/:conversationId`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.cappedList`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
  - Exports (types):
    - `McpCatalog`
    - `McpCatalogInstructions`
    - `McpCatalogTool`
    - `McpDegraded`
    - `McpHealth`
  - Exports (values):
    - `agentToolName`
    - `MCP_HEALTH_MAX_DEGRADED`
    - `MCP_SERVER_NAME`
    - `mcpCatalog`
    - `McpCatalogInstructionsSchema`
    - `McpCatalogSchema`
    - `McpCatalogToolSchema`
    - `McpDegradedSchema`
    - `mcpHealth`
    - `McpHealthSchema`
    - `mcpRequest`
- Cross-plugin:
  - Imported by: 25 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×6
    - `tasks` ×6
    - `conversations` ×4
    - `apps` ×3
    - `infra` ×2
    - `database/query`
    - `hints/ask`
    - `page/annotations/agent-access`
    - `plugin-meta/plugin-health`
  - Endpoint callers: `health`
- Sub-plugins:
  - **`browser`** — The health report's Agent browser row: whether the machine's agent-browser host runs, its sessions (what each is for — its task's title — its tab count, and how long until it closes if left idle), a…
  - **`health`** — The health report's MCP server row: critical while the latest MCP request failed (agents launched from here have no equin tools), attention while a per-connection contribution (a tool's gate or live…

<!-- AUTOGENERATED:END -->
