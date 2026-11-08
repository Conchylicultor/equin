/**
 * Tests for `blocking-fs/no-sync-fs` and `blocking-fs/sync-named`. Typed rule
 * tests (`createTypedRuleTester`): each case is a VIRTUAL file named under a
 * plugin's `server/` (a backend), `core/` (a helper) or `cli/` folder.
 */

import { setDefaultTimeout } from "bun:test";
import { relative } from "node:path";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import noSyncFs from "./no-sync-fs";
import syncNamed from "./sync-named";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SERVER_CASE = "plugins/audience/server/case.ts";
const CORE_CASE = "plugins/audience/core/case.ts";
const CLI_CASE = "plugins/audience/cli/case.ts";

const at = (file: string) => `${LINT_DIR}/${file}`;

/** A real `core/` helper named `*Sync` (timed-fs's glob scan), by relative path. */
const TIMED_FS = relative(
  `${LINT_DIR}/plugins/audience/server`,
  new URL("../../../../../../packages/plugins/timed-fs/core", import.meta.url)
    .pathname,
);

const PRELUDE = `
import { readFileSync, existsSync, closeSync, openSync } from "node:fs";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { scanGlobSync, scanGlob } from "${TIMED_FS}";
`;

const valid = (code: string, file: string) => ({
  filename: at(file),
  code: PRELUDE + code,
});
const invalid = (code: string, messageIds: string[], file: string) => ({
  filename: at(file),
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [SERVER_CASE, CORE_CASE, CLI_CASE],
});

ruleTester.run("no-sync-fs", noSyncFs, {
  valid: [
    valid(
      `export async function f() { return readFile("/x", "utf8"); }`,
      SERVER_CASE,
    ),
    // closeSync waits on no disk; owned-fd confines it.
    valid(`export function f(fd: number) { closeSync(fd); }`, SERVER_CASE),
    // A repo *Sync declared in a backend folder is checked where it calls.
    valid(
      `function localSync() {} export function f() { localSync(); }`,
      SERVER_CASE,
    ),
    // Out of scope: a helper folder and the CLI.
    valid(`export function f() { return readFileSync("/x"); }`, CLI_CASE),
    valid(`export function fSync() { return readFileSync("/x"); }`, CORE_CASE),
    valid(
      `export async function f() { for await (const p of scanGlob("*", ".")) void p; }`,
      SERVER_CASE,
    ),
  ],
  invalid: [
    invalid(
      `export function f() { return readFileSync("/x"); }`,
      ["fs"],
      SERVER_CASE,
    ),
    invalid(
      `export function f() { return fs.existsSync("/x"); }`,
      ["fs"],
      SERVER_CASE,
    ),
    invalid(
      `export function f() { return openSync("/x", "r"); }`,
      ["fs"],
      SERVER_CASE,
    ),
    invalid(
      `export function f() { return spawnSync("ps"); }`,
      ["process"],
      SERVER_CASE,
    ),
    invalid(
      `export function f() { return execFileSync("ps"); }`,
      ["process"],
      SERVER_CASE,
    ),
    // (Bun.spawnSync is matched by its bun-types declaration; the inferred
    // case project loads node's types only.)
    // A core/ helper named *Sync.
    invalid(
      `export function f() { return [...scanGlobSync("*", ".")]; }`,
      ["helper"],
      SERVER_CASE,
    ),
    // Handed on by reference: whoever receives it calls it on this thread.
    invalid(
      `export function f(ps: string[]) { return ps.map(existsSync); }`,
      ["fs"],
      SERVER_CASE,
    ),
    invalid(
      `export const reader = { read: readFileSync };`,
      ["fs"],
      SERVER_CASE,
    ),
    // A function VALUE carrying node's declaration (timed-fs's twins).
    invalid(
      `declare const readTwinSync: typeof fs.readFileSync; export function f(ps: string[]) { return ps.map((p) => readTwinSync(p)).concat(ps.map(readTwinSync)); }`,
      ["fs", "fs"],
      SERVER_CASE,
    ),
  ],
});

ruleTester.run("sync-named", syncNamed, {
  valid: [
    valid(
      `export function readConfigSync() { return readFileSync("/x"); }`,
      CORE_CASE,
    ),
    valid(`export const readConfigSync = () => readFileSync("/x");`, CORE_CASE),
    valid(
      `export async function readConfig() { return readFile("/x"); }`,
      CORE_CASE,
    ),
    // A callback runs on its caller's behalf: charged to the named function.
    valid(
      `export function existingSync(ps: string[]) { return ps.filter((p) => existsSync(p)); }`,
      CORE_CASE,
    ),
    // The name climbs through a repo *Sync helper.
    valid(
      `function innerSync() { return readFileSync("/x"); } export function outerSync() { return innerSync(); }`,
      CORE_CASE,
    ),
    // A wrapper at module scope: the variable is the blocking function.
    valid(
      `declare function wrap<F>(f: F): F; export const statFileSync = wrap(fs.statSync);`,
      CORE_CASE,
    ),
    valid(
      `export class Store { loadSync() { return readFileSync("/x"); } }`,
      CORE_CASE,
    ),
    valid(`export function close(fd: number) { closeSync(fd); }`, CORE_CASE),
    // A method of a type whose NAME ends in Sync is not blocking for it.
    valid(
      `interface CacheSync { get(): number } declare const c: CacheSync; export function read() { return c.get(); }`,
      CORE_CASE,
    ),
    // Backend and CLI folders are not helpers.
    valid(`export function f() { return readFileSync("/x"); }`, CLI_CASE),
  ],
  invalid: [
    invalid(
      `export function readConfig() { return readFileSync("/x"); }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export const readConfig = () => readFileSync("/x");`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export function existing(ps: string[]) { return ps.filter((p) => existsSync(p)); }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `function innerSync() { return readFileSync("/x"); } export function outer() { return innerSync(); }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export function list() { return [...scanGlobSync("*", ".")]; }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export function ps() { return spawnSync("ps"); }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export const store = { load() { return readFileSync("/x"); } };`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export class Store { load() { return readFileSync("/x"); } }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export function check(ps: string[]) { return ps.some(existsSync); }`,
      ["rename"],
      CORE_CASE,
    ),
    invalid(
      `export const config = readFileSync("/x");`,
      ["unnamed"],
      CORE_CASE,
    ),
    invalid(
      `export class Store { constructor() { readFileSync("/x"); } }`,
      ["unnamed"],
      CORE_CASE,
    ),
    invalid(
      `export function make() { return () => readFileSync("/x"); }`,
      ["unnamed"],
      CORE_CASE,
    ),
  ],
});
