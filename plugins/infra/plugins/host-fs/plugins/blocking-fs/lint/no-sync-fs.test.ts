/**
 * Tests for `blocking-fs/no-sync-fs`. A typed rule test (`createTypedRuleTester`
 * in `tooling/lint/core/testing`) — each case is a VIRTUAL file under an
 * inferred project with `@types/node`, named under this plugin's own
 * `server/` folder (backend code) or its `cli/` one (out of scope). The inferred project loads
 * no bun-types, so `Bun.resolveSync` / `scanSync` are not cased here.
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-sync-fs";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

// The plugin's own dir: a case under it is in `plugins/blocking-fs/server/`.
const PLUGIN_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SERVER_CASE = "server/case.ts";
const CLI_CASE = "cli/case.ts";

const PRELUDE = `
import { readFileSync, readdirSync as listSync, realpathSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
declare const p: string;
`;

const at = (file: string) => `${PLUGIN_DIR}/${file}`;
const valid = (code: string, file = SERVER_CASE) => ({
  filename: at(file),
  code: PRELUDE + code,
});
const invalid = (code: string, names: string[], file = SERVER_CASE) => ({
  filename: at(file),
  code: PRELUDE + code,
  errors: names.map((name) => ({ messageId: "fs" as const, data: { name } })),
});

const ruleTester = createTypedRuleTester({
  dir: PLUGIN_DIR,
  cases: [SERVER_CASE, CLI_CASE],
});

ruleTester.run("no-sync-fs", rule, {
  valid: [
    // The async API.
    valid(
      `async function f() { await readFile(p); await fs.promises.stat(p); }`,
    ),
    // A local function merely named *Sync.
    valid(`function loadSync(x: string) { return x; } loadSync(p);`),
    // Callbacks passed to an fs call are not themselves sync calls.
    valid(`fs.readFile(p, (err, data) => { void err; void data; });`),
    // Not covered by design: a call through a property not named like a
    // blocking function (`o.read(p)` below is not asked about) — the hand-on
    // itself is reported where it is written (see invalid).
    valid(`declare const o: { read: typeof fs.readFileSync }; o.read(p);`),
    // Out of scope: a CLI file.
    valid(`readFileSync(p);`, CLI_CASE),
  ],
  invalid: [
    invalid(`readFileSync(p);`, ["readFileSync"]),
    invalid(`fs.statSync(p);`, ["statSync"]),
    // An import alias keeps node's declaration.
    invalid(`listSync(p);`, ["readdirSync"]),
    // A twin typed as node's function (timed-fs's shape) keeps it too.
    invalid(
      `declare const timedReaddirSync: typeof fs.readdirSync; timedReaddirSync(p);`,
      ["readdirSync"],
    ),
    // A namespace member: the enclosing *Sync name.
    invalid(`realpathSync.native(p);`, ["realpathSync"]),
    // A sync call inside a callback, and an optional call.
    invalid(`[p].map((x) => existsSync(x)); fs.rmSync?.(p);`, [
      "existsSync",
      "rmSync",
    ]),
    // Handing a blocking function on by reference is reported where it is
    // written: whoever receives it calls it on this thread.
    invalid(`const o = { read: fs.readFileSync }; o.read(p);`, [
      "readFileSync",
    ]),
    // An optional chain on a receiver that may be absent.
    invalid(`declare const m: typeof fs | undefined; m?.readFileSync(p);`, [
      "readFileSync",
    ]),
  ],
});
