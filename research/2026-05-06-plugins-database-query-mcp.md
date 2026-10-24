# Database Query MCP Tool

## Context

Models running in worktrees cannot inspect the embedded PG database. The CLI connects to the host DB (stale for worktrees). Models need read access to their own worktree's live DB for debugging/inspecting. This adds a `query_db` MCP tool under a new top-level `database` umbrella plugin.

## Design decisions

- **Read-only via `BEGIN TRANSACTION READ ONLY`** — enforced at DB level, not regex parsing. PG rejects mutations with a clear error. No brittle SQL parsing needed.
- **Default to agent's own worktree DB** — resolved from `conversationId` → `getConversation()` → `basename(conv.worktreePath)` = DB name. Optional `database` param for cross-worktree queries.
- **No `list_databases` companion** — agents know their worktree name. Add later if needed.
- **200-row cap** — prevents accidentally dumping large tables. Agents can use `LIMIT` for less.
- **5s statement timeout** — `SET LOCAL statement_timeout = '5000'` prevents runaway queries.
- **Separate from `infra/database`** — infra/database is cluster management; this is model-facing DB features.

## File structure

```
plugins/database/
├── package.json                             # @singularity/plugin-database
├── CLAUDE.md
└── plugins/
    └── query/
        ├── package.json                     # @singularity/plugin-database-query
        ├── CLAUDE.md
        └── server/
            ├── index.ts                     # ServerPluginDefinition, register: [queryDbTool]
            └── internal/
                └── mcp-tools.ts             # Mcp.tool({ name: "query_db", ... })
```

Server-only — no `web/` directory.

## Implementation

### 1. `plugins/database/package.json`

```json
{ "name": "@singularity/plugin-database", "private": true, "version": "0.0.1" }
```

### 2. `plugins/database/plugins/query/package.json`

```json
{ "name": "@singularity/plugin-database-query", "private": true, "version": "0.0.1" }
```

### 3. `plugins/database/plugins/query/server/internal/mcp-tools.ts`

```typescript
import { z } from "zod";
import { basename } from "path";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { getConversation } from "@plugins/tasks-core/server";
import { openShortLivedClient } from "@server/db/client";
import { databaseExists } from "@plugins/infra/plugins/database/server";

const MAX_ROWS = 200;

export const queryDbTool = Mcp.tool({
  name: "query_db",
  description: `Execute a read-only SQL query against a worktree's PostgreSQL database.
For debugging and inspection only. All queries run in a READ ONLY transaction.
Returns up to ${MAX_ROWS} rows.

Default: queries the current conversation's worktree database.
Pass \`database\` to target a different worktree (e.g. "att-1778089188-7uvf" or "singularity" for main).`,
  inputSchema: {
    sql: z.string().min(1).describe("SQL query to execute (read-only)."),
    database: z.string().optional().describe(
      "Target database name (worktree name). Defaults to the conversation's own worktree DB."
    ),
  },
  async handler({ sql, database }, { conversationId }) {
    let dbName: string;
    if (database) {
      dbName = database;
    } else {
      const conv = await getConversation(conversationId);
      if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
      dbName = basename(conv.worktreePath);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
      throw new Error(`Unsafe database name: "${dbName}"`);
    }
    if (!(await databaseExists(dbName))) {
      throw new Error(`Database not found: "${dbName}"`);
    }

    const pool = openShortLivedClient(dbName);
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SET LOCAL statement_timeout = '5000'");
        let result;
        try {
          result = await client.query(sql);
        } finally {
          await client.query("ROLLBACK");
        }
        const rows = result.rows.slice(0, MAX_ROWS);
        const columns = result.fields.map((f: { name: string }) => f.name);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              database: dbName,
              columns,
              rows,
              rowCount: result.rowCount,
              truncated: (result.rowCount ?? 0) > MAX_ROWS,
            }),
          }],
        };
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  },
});
```

### 4. `plugins/database/plugins/query/server/index.ts`

```typescript
import type { ServerPluginDefinition } from "@server/types";
import { queryDbTool } from "./internal/mcp-tools";

export default {
  id: "database-query",
  name: "Database Query",
  description: "MCP tool for agents to query worktree databases for debugging and inspection.",
  register: [queryDbTool],
} satisfies ServerPluginDefinition;
```

### 5. Update `CLAUDE.md`

Add under `## Agent Workflow`, after the rules section:

```markdown
### MCP Tools

Agents have access to MCP tools provided by the Singularity server. Key tools:

- `query_db` — Read-only SQL query against the worktree's PostgreSQL database. For **debugging and inspection only** — mutations are rejected at the DB level. Defaults to the agent's own worktree DB; pass `database` to query another worktree or `"singularity"` for main.
```

### 6. Build & verify

```bash
./equin build
# Then from a conversation, call the MCP tool:
# query_db({ sql: "SELECT tablename FROM pg_tables WHERE schemaname = 'public'" })
```

## Key files to modify/create

- `plugins/database/package.json` (new)
- `plugins/database/plugins/query/package.json` (new)
- `plugins/database/plugins/query/server/index.ts` (new)
- `plugins/database/plugins/query/server/internal/mcp-tools.ts` (new)
- `CLAUDE.md` (update — add MCP Tools section)

## Reused primitives

- `Mcp.tool()` from `@plugins/infra/plugins/mcp/server` — tool registration
- `getConversation()` from `@plugins/tasks-core/server` — conversation → worktree resolution
- `openShortLivedClient()` from `@server/db/client` — cross-DB connection
- `databaseExists()` from `@plugins/infra/plugins/database/server` — validation
