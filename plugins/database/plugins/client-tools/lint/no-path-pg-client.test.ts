/**
 * Tests for the `no-path-pg-client` lint rule: a Postgres client tool spawned
 * by bare name (argv[0] a string literal) is a PATH lookup and is flagged.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-path-pg-client";

// Hand RuleTester bun's own describe/it, or it registers nothing under
// `./equin test`.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

ruleTester.run(
  "no-path-pg-client",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
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
  },
);
