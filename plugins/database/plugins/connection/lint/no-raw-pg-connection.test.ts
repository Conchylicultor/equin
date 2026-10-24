/**
 * Tests for the `no-raw-pg-connection` lint rule.
 *
 * Backend code must build every database connection through the connection
 * plugin, so each call carries a deadline. The rule flags `new Pool` /
 * `new Client` from "pg" in every import shape, and a `connectionString` handed
 * to graphile-worker (which would build its own raw pool) — outside the
 * connection plugin, tooling directories and tests.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-raw-pg-connection";

// Hand RuleTester bun's own describe/it. Left to find them as globals, it
// registers nothing under `./equin test` ("Ran 0 tests across 1 file"),
// so a broken rule would pass green.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const BACKEND = "plugins/infra/plugins/jobs/server/internal/job-lock.ts";

const EXEMPT_PATHS = [
  "plugins/database/plugins/connection/server/internal/client.ts",
  "plugins/database/plugins/migrations/check/internal/direct-db.ts",
  "plugins/database/plugins/embedded/scripts/start.ts",
  "plugins/database/plugins/admin/e2e/fork-bench.ts",
  "plugins/database/lint/no-pool-await-in-transaction.ts",
  "plugins/page/plugins/editor/server/internal/page-forest.test.ts",
  "plugins/database/plugins/query-deadline/web/__tests__/database-health-row.test.tsx",
  "plugins/database/plugins/query-deadline/server/__tests__/helper.ts",
];

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-raw-pg-connection",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The sanctioned door.
      {
        filename: BACKEND,
        code: `import { createDbPool } from "@plugins/database/plugins/connection/server";
const pool = createDbPool({ name: "job-lock", connectionString: url, max: 4 });`,
      },
      // Types from "pg" are fine; only construction is banned.
      {
        filename: BACKEND,
        code: `import type { Pool, PoolClient } from "pg";
let p: Pool;`,
      },
      {
        filename: BACKEND,
        code: `import { type Pool, escapeLiteral } from "pg";
escapeLiteral("x");`,
      },
      // A Pool that is not pg's.
      {
        filename: BACKEND,
        code: `import { Pool } from "undici";
new Pool("http://x");`,
      },
      {
        filename: BACKEND,
        code: `class Client {}
new Client();`,
      },
      // graphile-worker given a pool, not a connection string.
      {
        filename: BACKEND,
        code: `import { run, makeWorkerUtils } from "graphile-worker";
await run({ pgPool: pool, taskList });
await makeWorkerUtils({ pgPool: pool });`,
      },
      // A connectionString to something that is not a graphile-worker entrypoint.
      {
        filename: BACKEND,
        code: `import { quickAddJob } from "graphile-worker";
someOtherRun({ connectionString: url });`,
      },
      // Exempt: the connection plugin itself, tooling directories, and tests.
      ...EXEMPT_PATHS.map((filename) => ({
        filename,
        code: `import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
new Pool({ connectionString: url });
await runMigrations({ connectionString: url });`,
      })),
    ],
    invalid: [
      {
        filename: BACKEND,
        code: `import { Pool } from "pg";
const pool = new Pool({ connectionString: url, max: 4 });`,
        errors: [{ messageId: "rawPgConnection", data: { name: "Pool" } }],
      },
      {
        filename:
          "plugins/database/plugins/change-feed/server/internal/listener.ts",
        code: `import { Client } from "pg";
const c = new Client({ connectionString: url });`,
        errors: [{ messageId: "rawPgConnection", data: { name: "Client" } }],
      },
      // Aliased named import.
      {
        filename: BACKEND,
        code: `import { Pool as PgPool } from "pg";
new PgPool();`,
        errors: [{ messageId: "rawPgConnection", data: { name: "Pool" } }],
      },
      // Default import.
      {
        filename: BACKEND,
        code: `import pg from "pg";
new pg.Pool({}); new pg.Client({});`,
        errors: [
          { messageId: "rawPgConnection", data: { name: "Pool" } },
          { messageId: "rawPgConnection", data: { name: "Client" } },
        ],
      },
      // Namespace import, computed member.
      {
        filename: BACKEND,
        code: `import * as pg from "pg";
new pg["Client"]();`,
        errors: [{ messageId: "rawPgConnection", data: { name: "Client" } }],
      },
      // graphile-worker entrypoints given their own connection string.
      {
        filename: BACKEND,
        code: `import { run, runOnce, makeWorkerUtils, runMigrations as runGraphileMigrations } from "graphile-worker";
await run({ connectionString: url, taskList });
await runOnce({ "connectionString": url, taskList });
await makeWorkerUtils({ connectionString });
await runGraphileMigrations({ connectionString: url });`,
        errors: [
          { messageId: "graphileConnectionString", data: { name: "run" } },
          { messageId: "graphileConnectionString", data: { name: "runOnce" } },
          {
            messageId: "graphileConnectionString",
            data: { name: "makeWorkerUtils" },
          },
          {
            messageId: "graphileConnectionString",
            data: { name: "runMigrations" },
          },
        ],
      },
      {
        filename: BACKEND,
        code: `import * as graphile from "graphile-worker";
await graphile.makeWorkerUtils({ connectionString: url });`,
        errors: [
          {
            messageId: "graphileConnectionString",
            data: { name: "makeWorkerUtils" },
          },
        ],
      },
      // A path that merely CONTAINS a tooling word is not exempt.
      {
        filename:
          "plugins/database/plugins/admin/server/internal/cli-helpers.ts",
        code: `import { Pool } from "pg";
new Pool();`,
        errors: [{ messageId: "rawPgConnection", data: { name: "Pool" } }],
      },
    ],
  },
);
