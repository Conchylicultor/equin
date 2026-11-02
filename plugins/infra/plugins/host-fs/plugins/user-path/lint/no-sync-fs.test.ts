/**
 * Tests for `user-path/no-sync-fs`. A typed rule test (`createTypedRuleTester` in
 * `tooling/lint/core/testing`) — each case is a VIRTUAL file under an inferred
 * project with `@types/node`, named
 * under a `server/` or `core/` folder (runtime code) or a `cli/` one (out of
 * scope).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-sync-fs";

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
  messageIds: ("user" | "unproven")[],
  file = SERVER_CASE,
) => ({
  filename: at(file),
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [SERVER_CASE, CORE_CASE, CLI_CASE],
});

/* eslint-disable no-template-curly-in-string -- the cases ARE template literals */
ruleTester.run("no-sync-fs", rule, {
  valid: [
    // App-owned paths stay free to read synchronously.
    valid(`readdirSync(APP_DIR); readFileSync(join(APP_DIR, "x.json"));`),
    valid(
      `function f(dir: AppPath, kind: "a" | "b", n: number) { readFileSync(join(dir, kind, \`\${n}.json\`)); }`,
    ),
    valid(`if (maybeApp) readdirSync(maybeApp);`),
    valid('readFileSync(`${APP_DIR}/x.json`); existsSync(APP_DIR + ".lock");'),
    valid(
      `readFileSync("/etc/hosts"); readdirSync(join(import.meta.dir, "fixtures"));`,
    ),
    valid(`readdirSync(tmpdir()); readFileSync(resolve(APP_DIR, "a"));`),
    valid(`const lock = join(APP_DIR, "x.lock"); existsSync(lock);`),
    valid(`readdirSync(dirname(APP_DIR));`),
    // A descriptor, a link's target text, file contents: not paths read.
    valid(
      `fstatSync(3); symlinkSync(plain, APP_DIR); writeFileSync(APP_DIR, plain);`,
    ),
    // The async API on any path.
    valid(
      `async function f() { await readdir(picked); await readdir(plain); await realpath(join(picked, "a")); }`,
    ),
    // A typed path is no-unproven-claim's to police, not this rule's.
    valid(`existsSync(asAppPath(plain));`),
    // Out of scope: a CLI file.
    valid(`readdirSync(plain);`, CLI_CASE),
  ],
  invalid: [
    // A user-chosen path.
    invalid(`realpathSync(picked);`, ["user"]),
    invalid(`fs.readdirSync(picked);`, ["user"]),
    invalid(`realpathSync.native(picked);`, ["user"]),
    invalid(`for (const f of config.folders) existsSync(f.path);`, ["user"]),
    invalid(`readdirSync(join(picked, "sub"));`, ["user"]),
    invalid(`readdirSync(join(APP_DIR, picked));`, ["user"]),
    invalid("readdirSync(`${picked}/sub`);", ["user"]),
    invalid(
      `async function f() { const real = await realpath(picked); readdirSync(real); }`,
      ["user"],
    ),
    // An unmarked path is not proven — the point of the allow-list.
    invalid(`readdirSync(plain);`, ["unproven"]),
    // A plain-string tail under an app root may climb out of it.
    invalid(
      `function f(dir: AppPath, name: string) { readFileSync(join(dir, name)); }`,
      ["unproven"],
    ),
    invalid(
      "function f(dir: AppPath, name: string) { readFileSync(`${dir}/${name}`); }",
      ["unproven"],
    ),
    invalid(`readdirSync(APP_DIR + plain);`, ["unproven"]),
    invalid("readdirSync(`/Volumes/${plain}`);", ["unproven"]),
    invalid(`readFileSync(body.path);`, ["unproven"]),
    invalid(`function walk(dir: string) { return readdirSync(dir); }`, [
      "unproven",
    ]),
    invalid(`readdirSync(String(picked));`, ["unproven"]),
    invalid(`readdirSync(resolve(APP_DIR, plain));`, ["unproven"]),
    invalid("readdirSync(`${plain}/sub`);", ["unproven"]),
    invalid(`readdirSync(join(HOME_DIR, plain));`, ["unproven"]),
    invalid(`readdirSync(process.env.SOME_DIR!);`, ["unproven"]),
    invalid(`readdirSync(plain ?? APP_DIR);`, ["unproven"]),
    invalid(`writeFileSync(plain, "x");`, ["unproven"]),
    // Core code runs on a backend's thread too.
    invalid(`readdirSync(plain);`, ["unproven"], CORE_CASE),
  ],
});
/* eslint-enable no-template-curly-in-string */
