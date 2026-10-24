/**
 * Tests for `hook-value/hook-binding-name`. Run with
 * `./equin test plugins/framework/plugins/hook-value`.
 *
 * Typed RuleTester harness copied from
 * `plugins/primitives/plugins/passthrough/lint/no-unanchored-passthrough.test.ts`
 * — read its header for why each case is a VIRTUAL `case.tsx` under an inferred
 * project, and why `tsconfig.case.json` sets `types: []`.
 */

import { describe, it, setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./hook-binding-name";

// The first case pays for building the inferred program (seconds); every case
// after it is milliseconds. bun:test's default five-second budget is too tight.
setDefaultTimeout(60_000);

/** This directory — where `tsconfig.case.json` and the virtual case both sit. */
const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** The path every case is linted AS — nothing exists there (see the harness notes). */
const VIRTUAL_CASE = "case.tsx";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/**
 * The brand, declared inline: the virtual case cannot import. Kept the shape of
 * `core/internal/hook.ts`, so the suite pins the property name the rules read.
 */
const PRELUDE = `
type Hook<F extends (...args: never[]) => unknown> = F & { readonly __hook?: true };
declare function useState<T>(v: T): [T, (v: T) => void];
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, messageIds: string[]) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

// Hand RuleTester bun:test's describe/it explicitly: it only picks up ambient
// globals, and without them it runs every case at import time — failures still
// throw, but the run reports "0 tests" and names no case.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [VIRTUAL_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

ruleTester.run(
  "hook-binding-name",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A branded field under a hook name.
      valid(`interface Spec { useX: Hook<() => number> }`),
      valid(`interface Spec { useX?: Hook<(n: number) => string> }`),
      // The fallback shape: a union of a branded and a plain hook, bound use*.
      valid(`
        interface Spec { useZones?: Hook<() => string[]> }
        function useNoZones(): string[] { return []; }
        export function useView(a: Spec | undefined) {
          const useZones = a?.useZones ?? useNoZones;
          return useZones();
        }`),
      // A plain function passed INTO a Hook field via an object literal: the
      // literal's key is dictated by the target type, not checked here.
      valid(`
        interface Spec { useX: Hook<() => number> }
        const spec: Spec = { useX: () => 1 };
        const other: Spec = { useX() { return useState(1)[0]; } };`),
      // An unbranded function under any name — the rule never judges names
      // without the brand.
      valid(`
        const resolve = (n: number) => n + 1;
        interface Spec { render: () => number; onClick?: (e: unknown) => void }
        export function f(cb: () => void, { render }: Spec) { cb(); render(); }`),
      // A union field that is a string OR a hook, correctly named.
      valid(`interface Title { useText: string | Hook<() => string> }`),
      // An ordinary object type with many props (and a hook FIELD) is not
      // itself a hook.
      valid(`
        interface Pane { id: string; useResolve: Hook<() => number>; meta: Record<string, unknown> }
        declare const pane: Pane;
        const p = pane;
        const { id, ...rest } = pane;
        const has = pane.useResolve !== undefined;
        const n = pane.useResolve ? 1 : 2;`),
      // Destructured under a hook name.
      valid(`
        interface Props { useResolve: Hook<() => number> }
        export function G({ useResolve }: Props) { return useResolve(); }`),
    ],
    invalid: [
      // The property signature itself.
      invalid(`interface Spec { resolve: Hook<() => number> }`, [
        "hookBindingName",
      ]),
      invalid(`type Spec = { resolve?: Hook<() => number> }`, [
        "hookBindingName",
      ]),
      // Pulling a hook field out under a plain name.
      invalid(
        `
        interface Spec { useRowDecoration?: Hook<(row: string) => string> }
        declare const props: Spec;
        const f = (row: string) => row;
        const decorate = props.useRowDecoration ?? f;`,
        ["hookBindingName"],
      ),
      // The binding's own type LOSES the brand in each of these — `Hook<F> | F`
      // subtype-reduces to `F` — so the rule reads the operands / the source
      // field instead.
      invalid(
        `
        interface Spec { useX?: Hook<() => number> }
        declare const s: Spec;
        const g = () => 1;
        const a = s.useX ? s.useX : g;
        const b = (s.useX ?? g) as () => number;
        export function k(h = s.useX ?? g) { return h; }
        const { useX: d = g } = s;`,
        [
          "hookBindingName",
          "hookBindingName",
          "hookBindingName",
          "hookBindingName",
        ],
      ),
      // A destructuring rename reports the LOCAL name.
      invalid(
        `
        interface Spec { useResolve: Hook<() => number> }
        declare const p: Spec;
        const { useResolve: resolve } = p;`,
        ["hookBindingName"],
      ),
      // A parameter typed as a hook.
      invalid(
        `
        type ResolveHook = Hook<(params: string) => number>;
        export const run = (resolve: ResolveHook, params: string) => resolve(params);`,
        ["hookBindingName"],
      ),
      invalid(
        `
        export function run(resolve?: Hook<() => number>) { return resolve?.(); }`,
        ["hookBindingName"],
      ),
      // The original StickyResolveGuard shape: the prop declaration AND the
      // destructured binding each report.
      invalid(
        `
        export function G({ resolve }: { resolve: Hook<() => number> }) {
          return resolve();
        }`,
        ["hookBindingName", "hookBindingName"],
      ),
      // A class property holding a hook.
      invalid(
        `
        function useThing() { return 1; }
        class Holder { resolve: Hook<() => number> = useThing; }`,
        ["hookBindingName"],
      ),
    ],
  },
);
