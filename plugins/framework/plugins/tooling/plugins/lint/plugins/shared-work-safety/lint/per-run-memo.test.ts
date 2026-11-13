/**
 * Tests for `per-run-memo` — a type-aware rule: each case is linted as a
 * virtual `case.ts` beside this file, type-checked under an inferred project
 * (`createTypedRuleTester` in `tooling/lint/core/testing`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./per-run-memo";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

// The shapes, structurally: a file set, a pass holding one, and unrelated keys.
const PRELUDE = `
interface RepoFiles { readonly root: string; all(): readonly string[]; has(p: string): boolean; under(d: string): readonly string[]; read(p: string): Promise<string | null> }
interface RepoSnapshot extends RepoFiles { blobOf(p: string): string }
interface CodegenPass { readonly root: string; readonly repo: RepoSnapshot }
interface PluginTree { readonly roots: readonly string[] }
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId: "handRolled" as const }],
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("per-run-memo", rule, {
  valid: [
    // Keyed by something that is not a file set.
    valid(`const byTree = new WeakMap<PluginTree, number>();`),
    valid(`const byPath = new Map<string, Promise<string>>();`),
    // Not module-level: a memo a function owns lives as long as its call.
    valid(
      `export function f(): void { const m = new WeakMap<RepoFiles, number>(); void m; }`,
    ),
    // A generic key (the primitive itself).
    valid(
      `export function memo<K extends object, V>(): WeakMap<K, V> { return new WeakMap<K, V>(); }`,
    ),
  ],
  invalid: [
    invalid(`const memo = new WeakMap<RepoFiles, Promise<number>>();`),
    invalid(`export const memo = new Map<RepoSnapshot, number>();`),
    // A pass holding the set under \`repo\`.
    invalid(`const trees = new WeakMap<CodegenPass, Promise<PluginTree>>();`),
    // The key type inferred from the binding's annotation.
    invalid(`const memo: WeakMap<RepoFiles, number> = new WeakMap();`),
  ],
});
