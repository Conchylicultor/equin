/**
 * Tests for `user-path/no-sync-fs`. Typed RuleTester harness as in
 * `watcher-safety/no-detached-watch-reaction` — each case is a VIRTUAL file
 * under an inferred project (`tsconfig.case.json`, with `@types/node`), named
 * under a `server/` folder (backend code) or a `web/` one.
 */

import { describe, it, setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-sync-fs";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SERVER_CASE = "server/case.ts";
const WEB_CASE = "web/case.ts";

/** The brand, spelled as `UserPathSchema` declares it. */
const PRELUDE = `
import type { z } from "zod";
import { join, basename } from "node:path";
import { readdirSync, realpathSync, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { readdir, realpath } from "node:fs/promises";
type UserPath = string & z.$brand<"UserPath">;
declare const picked: UserPath;
declare const config: { folders: { path: UserPath }[] };
declare const APP_DIR: string;
`;

const at = (file: string) => `${LINT_DIR}/${file}`;
const valid = (code: string, file = SERVER_CASE) => ({
  filename: at(file),
  code: PRELUDE + code,
});
const invalid = (
  code: string,
  messageIds: ("sync" | "widened")[],
  file = SERVER_CASE,
) => ({
  filename: at(file),
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [SERVER_CASE, WEB_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

ruleTester.run(
  "no-sync-fs",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // App-owned paths stay free to read synchronously.
      valid(`readdirSync(APP_DIR); readFileSync(join(APP_DIR, "x.json"));`),
      // The async API on a user path.
      valid(
        `async function f() { await readdir(picked); await realpath(join(picked, "a")); }`,
      ),
      // Library consumers and derivers are not widening.
      valid(`console.log(picked); const n = basename(picked);`),
      // A repo function that declares UserPath keeps the brand.
      valid(`function probe(p: UserPath) { return p; } probe(picked);`),
      // Returning it where the signature says UserPath.
      valid(`function first(): UserPath { return config.folders[0]!.path; }`),
      // Web code may show a user path as a string.
      valid(`function label(s: string) { return s; } label(picked);`, WEB_CASE),
    ],
    invalid: [
      invalid(`realpathSync(picked);`, ["sync"]),
      invalid(`fs.readdirSync(picked);`, ["sync"]),
      invalid(`realpathSync.native(picked);`, ["sync"]),
      invalid(`readdirSync(picked satisfies string);`, ["sync"]),
      invalid(`for (const f of config.folders) existsSync(f.path);`, ["sync"]),
      invalid(`config.folders.map((f) => readdirSync(f.path));`, ["sync"]),
      // Derived paths keep the taint.
      invalid(`readdirSync(join(picked, "sub"));`, ["sync"]),
      // eslint-disable-next-line no-template-curly-in-string -- the case IS a template literal
      invalid("readdirSync(`${picked}/sub`);", ["sync"]),
      invalid(`const sub = join(picked, "x"); readdirSync(sub);`, ["sync"]),
      invalid(
        `async function f() { const real = await realpath(picked); readdirSync(real); }`,
        ["sync"],
      ),
      // Even in web code a sync call is reported.
      invalid(`readdirSync(picked);`, ["sync"], WEB_CASE),
      // Dropping the brand in backend code.
      invalid(`function walk(dir: string) { return dir; } walk(picked);`, [
        "widened",
      ]),
      invalid(`const s: string = picked;`, ["widened"]),
      invalid(
        `function dirs(): string[] { return config.folders.map((f) => f.path); }`,
        ["widened"],
      ),
      invalid(
        `const deps: { folders: () => string[] } = { folders: () => config.folders.map((f) => f.path) };`,
        ["widened"],
      ),
    ],
  },
);
