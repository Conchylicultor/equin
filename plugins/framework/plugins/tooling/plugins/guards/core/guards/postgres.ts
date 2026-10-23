import { defineGuard } from "../define-guard";
import { findCall } from "../parse-shell";
import type { BashInput } from "../types";

const POSTGRES_COMMANDS = new Set([
  "psql",
  "pg_dump",
  "pg_dumpall",
  "pg_restore",
  "createdb",
  "dropdb",
  "createuser",
  "dropuser",
  "pg_isready",
  "pg_basebackup",
  "pg_ctl",
  "postgres",
  "postmaster",
  "vacuumdb",
  "reindexdb",
  "clusterdb",
]);

export const postgresGuard = defineGuard<BashInput>({
  name: "postgres",
  matcher: "Bash",
  bypassToken: ".allow-postgres",
  check(input) {
    const cmd = input.command;
    if (!cmd) return null;
    const blocked = findCall(cmd, (c) => POSTGRES_COMMANDS.has(c.name));
    if (!blocked) return null;
    return {
      blocked: `Direct PostgreSQL CLI command blocked: ${blocked.name}.`,
      why: "Blocked commands: psql, pg_dump, pg_restore, createdb, dropdb, and other pg_* utilities.",
      hint: "Use the `query_db` MCP tool for database inspection and debugging — it runs read-only queries against the worktree's database safely. Database mutations are managed by the server (migrations via `./equin build`).",
    };
  },
});
