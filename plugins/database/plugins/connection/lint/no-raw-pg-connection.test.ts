/**
 * Tests for the `no-raw-pg-connection` lint rule.
 *
 * Backend code must build every database connection through the connection
 * plugin, so each call carries a deadline. The rule flags `new Pool` /
 * `new Client` from "pg" in every import shape, and a `connectionString` handed
 * to graphile-worker (which would build its own raw pool) — skipping only
 * `check/` and `lint/` directories itself. `cli`/`script` files and tests are
 * the lint barrel's `outOfScope`, and the connection plugin is exempted by its
 * own manifest. Who is exempt is not the rule's business: the owner's
 * own files are silenced by its `exempt/index.ts`, tested for every manifest
 * at once in lint/core's `exemptions-honored.test.ts`. Here the rule fires on
 * them, which is what proves it carries no owner allowlist of its own.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-raw-pg-connection";

const ruleTester = createRuleTester();

const BACKEND = "plugins/infra/plugins/jobs/server/internal/job-lock.ts";

/** The directories the rule skips itself (leaf folders, not file categories). */
const SKIPPED_PATHS = [
  "plugins/database/plugins/migrations/check/internal/direct-db.ts",
  "plugins/database/lint/no-pool-await-in-transaction.ts",
];

const RAW = `import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
new Pool({ connectionString: url });
await runMigrations({ connectionString: url });`;

ruleTester.run("no-raw-pg-connection", rule, {
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
    // The rule's own skip: check/ and lint/ directories.
    ...SKIPPED_PATHS.map((filename) => ({ filename, code: RAW })),
  ],
  invalid: [
    // The connection plugin's own file: the rule fires there — its
    // exempt/index.ts, not the rule, is what silences it.
    {
      filename: "plugins/database/plugins/connection/server/internal/client.ts",
      code: RAW,
      errors: [
        { messageId: "rawPgConnection", data: { name: "Pool" } },
        {
          messageId: "graphileConnectionString",
          data: { name: "runMigrations" },
        },
      ],
    },
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
