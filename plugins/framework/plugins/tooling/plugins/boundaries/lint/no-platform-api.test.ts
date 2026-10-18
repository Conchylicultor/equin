/**
 * Tests for the `no-platform-api` lint rule. The folder under lint comes from
 * the RuleTester `filename` option.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-platform-api";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const PLUGIN = "/repo/plugins/tasks/plugins/task-category";
const SERVER = `${PLUGIN}/server/internal/handler.ts`;
const CORE = `${PLUGIN}/core/x.ts`;
const SHARED = `${PLUGIN}/shared/x.ts`;
const WEB = `${PLUGIN}/web/x.tsx`;
const MACHINE = `${PLUGIN}/machine/internal/x.ts`;
const CENTRAL = "/repo/plugins/auth/central/x.ts";
const CHECK = `${PLUGIN}/check/index.ts`;

const err = (folder: string, specifier: string) => ({
  messageId: "platformApi" as const,
  data: { folder, specifier },
});

ruleTester.run(
  "no-platform-api",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Portable imports.
      { code: `import { z } from "zod";`, filename: SERVER },
      { code: `import { sql } from "drizzle-orm";`, filename: SERVER },
      {
        code: `import { a } from "@plugins/database/server";`,
        filename: SERVER,
      },
      // Types erase.
      { code: `import type { Pool } from "pg";`, filename: SERVER },
      { code: `import { type Pool } from "pg";`, filename: CORE },
      { code: `export type { Stats } from "node:fs";`, filename: CORE },
      // Folders whose row allows platform APIs.
      { code: `import { readFile } from "node:fs";`, filename: MACHINE },
      { code: `import { Pool } from "pg";`, filename: CENTRAL },
      { code: `import { spawn } from "node:child_process";`, filename: CHECK },
      // Outside plugins/.
      {
        code: `import { readFile } from "node:fs";`,
        filename: "/repo/cli/x.ts",
      },
    ],
    invalid: [
      {
        code: `import { readFile } from "node:fs";`,
        filename: SERVER,
        errors: [err("server", "node:fs")],
      },
      {
        code: `import { join } from "path";`,
        filename: CORE,
        errors: [err("core", "path")],
      },
      {
        code: `import { Pool } from "pg";`,
        filename: SHARED,
        errors: [err("shared", "pg")],
      },
      {
        code: `import { run } from "graphile-worker";`,
        filename: WEB,
        errors: [err("web", "graphile-worker")],
      },
      {
        code: `import { type A, b } from "@parcel/watcher";`,
        filename: SERVER,
        errors: [err("server", "@parcel/watcher")],
      },
      {
        code: `import "bun:ffi";`,
        filename: SERVER,
        errors: [err("server", "bun:ffi")],
      },
      {
        code: `export { drizzle } from "drizzle-orm/node-postgres";`,
        filename: SERVER,
        errors: [err("server", "drizzle-orm/node-postgres")],
      },
      {
        code: `export * from "node:os";`,
        filename: CORE,
        errors: [err("core", "node:os")],
      },
      {
        code: `const m = await import("node:child_process");`,
        filename: SERVER,
        errors: [err("server", "node:child_process")],
      },
      {
        code: `const fs = require("fs");`,
        filename: SERVER,
        errors: [err("server", "fs")],
      },
      // A sub-plugin's folder is judged by its own row.
      {
        code: `import { $ } from "bun";`,
        filename: "/repo/plugins/a/plugins/b/plugins/c/server/x.ts",
        errors: [err("server", "bun")],
      },
    ],
  },
);
