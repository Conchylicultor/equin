/**
 * Tests for the `no-path-pg-client` lint rule: a Postgres client tool spawned
 * by bare name (argv[0] a string literal) is a PATH lookup and is flagged.
 */

import rule from "./no-path-pg-client";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-path-pg-client", rule, {
  valid: [
    { code: `spawnCaptured([pgClientBin("pg_dump"), "-Fc", db], opts);` },
    {
      code: `spawnCaptured([pgClientBin("pg_restore"), "-d", db, file], opts);`,
    },
    // A name in a list, not argv[0].
    { code: `const blocked = new Set(["psql", "pg_dump", "pg_restore"]);` },
    { code: `spawnCaptured(["git", "log"], opts);` },
    { code: `const msg = "pg_dump failed";` },
    // Lists of tool names run nothing.
    { code: `const TOOLS = ["pg_dump", "pg_restore"] as const;` },
    {
      code: `const banned = new Set(["pg_dump", "pg_restore", "pg_dumpall"]);`,
    },
  ],
  invalid: [
    {
      code: `spawnCaptured(["pg_dump", "-Fc", "-f", out, db], opts);`,
      errors: [{ messageId: "pathLookup", data: { name: "pg_dump" } }],
    },
    {
      code: `await spawnCaptured(["pg_restore", "-d", temp, archive], opts);`,
      errors: [{ messageId: "pathLookup", data: { name: "pg_restore" } }],
    },
    {
      code: `Bun.spawn(backgroundArgv(["pg_dumpall", "--globals-only"]));`,
      errors: [{ messageId: "pathLookup", data: { name: "pg_dumpall" } }],
    },
  ],
});
