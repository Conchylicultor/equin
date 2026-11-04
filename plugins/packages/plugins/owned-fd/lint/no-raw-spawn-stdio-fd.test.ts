/**
 * Tests for `no-raw-spawn-stdio-fd` — a type-aware rule: each case is linted
 * as a virtual `case.ts` beside this file, type-checked under an inferred
 * project (`createTypedRuleTester` in `tooling/lint/core/testing`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-raw-spawn-stdio-fd";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
interface OwnedFd { readonly fd: number; readonly closed: boolean; close(): void }
type Stdio = number | "pipe" | "ignore" | "inherit" | null;
declare const Bun: { spawn(cmd: string[], opts: { stdin?: Stdio; stdout?: Stdio; stderr?: Stdio; stdio?: Stdio[] }): void };
declare function spawn(cmd: string, args: string[], opts: { stdio?: Stdio[] }): void;
declare const out: OwnedFd;
declare const maybe: OwnedFd | undefined;
declare const raw: number;
declare const flag: boolean;
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, count = 1) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: Array.from({ length: count }, () => ({
    messageId: "rawFd" as const,
  })),
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("no-raw-spawn-stdio-fd", rule, {
  valid: [
    valid(`Bun.spawn(["x"], { stdout: "pipe", stderr: "inherit" });`),
    valid(`Bun.spawn(["x"], { stdout: flag ? "pipe" : "inherit" });`),
    valid(`spawn("x", [], { stdio: ["ignore", "pipe", "pipe"] });`),
    valid(`Bun.spawn(["x"], { stdout: out.fd, stderr: "pipe" });`),
    valid(`Bun.spawn(["x"], { stdin: maybe?.fd ?? "ignore" });`),
    valid(`Bun.spawn(["x"], { stdout: flag ? out.fd : "inherit" });`),
    // Not a spawn's options.
    valid(`const o = { stdout: raw };`),
  ],
  invalid: [
    invalid(`Bun.spawn(["x"], { stdout: raw });`),
    invalid(`Bun.spawn(["x"], { stdin: raw ?? "ignore", stderr: 2 });`, 2),
    invalid(`Bun.spawn(["x"], { stdout: flag ? raw : "pipe" });`),
    invalid(`spawn("x", [], { stdio: ["ignore", raw, "pipe"] });`),
  ],
});
