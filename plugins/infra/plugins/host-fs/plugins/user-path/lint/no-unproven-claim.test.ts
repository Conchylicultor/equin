/**
 * Tests for `user-path/no-unproven-claim`. Typed RuleTester harness as in
 * `watcher-safety/no-detached-watch-reaction` — each case is a VIRTUAL file
 * under an inferred project (`tsconfig.case.json`, with `@types/node`), named
 * under a `server/` or `core/` folder (runtime code) or a `cli/` one (out of
 * scope).
 */

import { describe, it, setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unproven-claim";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SERVER_CASE = "server/case.ts";
const CORE_CASE = "core/case.ts";
const CLI_CASE = "cli/case.ts";

/** The brands, spelled as `user-path/core` declares them. */
const PRELUDE = `
import type { z } from "zod";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readdirSync, realpathSync, existsSync, readFileSync, fstatSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { readdir, realpath } from "node:fs/promises";
type UserPath = string & z.$brand<"UserPath">;
type AppPath = string & z.$brand<"AppPath">;
declare function asAppPath(path: string): AppPath;
declare const picked: UserPath;
declare const config: { folders: { path: UserPath }[] };
declare const APP_DIR: AppPath;
declare const maybeApp: AppPath | undefined;
declare const plain: string;
declare const HOME_DIR: string;
declare const body: { path: string };
`;

const at = (file: string) => `${LINT_DIR}/${file}`;
const valid = (code: string, file = SERVER_CASE) => ({
  filename: at(file),
  code: PRELUDE + code,
});
const invalid = (
  code: string,
  messageIds: ("claim" | "launder")[],
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
        allowDefaultProject: [SERVER_CASE, CORE_CASE, CLI_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

/* eslint-disable no-template-curly-in-string -- the cases ARE template literals */
ruleTester.run(
  "no-unproven-claim",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Proven by the rule: only the type is given.
      valid(`const a = asAppPath(join(APP_DIR, "meta", "x.json"));`),
      valid("const a = asAppPath(`${APP_DIR}.tmp`);"),
      valid(
        `const a = asAppPath(dirname(APP_DIR)); const b = asAppPath(realpathSync(APP_DIR));`,
      ),
      valid(`const a = asAppPath(fs.mkdtempSync(join(tmpdir(), "x-")));`),
      valid(`const a = asAppPath(resolve(import.meta.dir, ".."));`),
      valid(`const a = asAppPath("/opt/tool");`),
      valid(`const a = APP_DIR as AppPath; const b = asAppPath(APP_DIR);`),
      // Out of scope: a CLI file.
      valid(`const a = asAppPath(plain);`, CLI_CASE),
    ],
    invalid: [
      // A claim nothing backs.
      invalid(`const a = asAppPath(plain);`, ["claim"]),
      // A plain-string tail may climb out of the root: joinAppPath, not a claim.
      invalid(`const a = asAppPath(join(APP_DIR, plain));`, ["claim"]),
      invalid(`function f(root: string) { return asAppPath(root); }`, [
        "claim",
      ]),
      invalid(`const a = asAppPath(body.path);`, ["claim"]),
      invalid(`const a = asAppPath(join(HOME_DIR, "app"));`, ["claim"]),
      invalid(`const a = asAppPath(process.env.SOME_DIR!);`, ["claim"]),
      invalid(`const a = plain as AppPath;`, ["claim"]),
      invalid(`const a = plain as unknown as AppPath;`, ["claim"]),
      invalid(`const a = <AppPath>plain;`, ["claim"]),
      invalid(`const a = [plain].map(asAppPath);`, ["claim"]),
      invalid(`const a = asAppPath(plain);`, ["claim"], CORE_CASE),
      // A user path is never claimable.
      invalid(`existsSync(asAppPath(picked));`, ["launder"]),
      invalid(`const p = picked as unknown as AppPath;`, ["launder"]),
      invalid(`const p = asAppPath(join(APP_DIR, picked));`, ["launder"]),
    ],
  },
);
/* eslint-enable no-template-curly-in-string */
