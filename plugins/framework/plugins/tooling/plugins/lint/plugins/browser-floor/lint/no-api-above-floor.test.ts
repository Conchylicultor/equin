/**
 * Tests for `browser-floor/no-api-above-floor`: virtual files under an
 * inferred project (DOM + ES2023 lib, `@types/node`), named under a browser-
 * built folder (`web/`, `core/`) or a server one (out of scope).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-api-above-floor";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

// The plugin dir, so a case sits in a plugin's `web/` / `core/` / `server/`
// folder exactly as a real file does.
const LINT_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WEB_CASE = "web/case.ts";
const CORE_CASE = "core/case.ts";
const SERVER_CASE = "server/case.ts";

const at = (file: string) => `${LINT_DIR}/${file}`;
const valid = (code: string, file = WEB_CASE) => ({ filename: at(file), code });
const invalid = (code: string, count = 1, file = WEB_CASE) => ({
  filename: at(file),
  code,
  errors: Array.from({ length: count }, () => ({
    messageId: "aboveFloor" as const,
  })),
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [WEB_CASE, CORE_CASE, SERVER_CASE],
});

ruleTester.run("no-api-above-floor", rule, {
  valid: [
    // Built-ins the floor has.
    valid(`const u = new URL("https://a.b"); u.hostname;`),
    valid(`[1, 2].at(-1); [1, 2].findLast((x) => x > 1); structuredClone({});`),
    valid(`Object.hasOwn({}, "a"); [3, 1].toSorted();`), // Firefox 115, Safari 16,
    // A feature test is not a use, and a use behind one is safe.
    valid(`if (typeof URL.canParse === "function") {}`),
    valid(`if (typeof URL.canParse === "function") URL.canParse("x");`),
    valid(
      `export const ok = typeof URLPattern === "undefined" ? null : new URLPattern({});`,
    ),
    valid(
      `export const ok = "startViewTransition" in document && document.startViewTransition(() => {});`,
    ),
    valid(
      `export function f() { if (typeof document.startViewTransition !== "function") return; document.startViewTransition(() => {}); }`,
    ),
    valid(`document.startViewTransition?.(() => {});`),
    // KeyboardEvent.repeat: partial before Chrome 137, complete after — shipped all along.
    valid(`export const r = (e: KeyboardEvent) => e.repeat;`),
    // A member of the same name on the app's own type.
    valid(
      `const o = { canParse: (s: string) => s.length > 0 }; o.canParse("x");`,
    ),
    // A local shadowing a newer global.
    valid(`export {}; const URLPattern = class {}; new URLPattern();`),
    // Server code runs on Bun, not in a visitor's browser — unless a browser
    // host's worker loads it (the browser-floor:worker-closure check says so).
    valid(`URL.canParse("x");`, SERVER_CASE),
  ],
  invalid: [
    // The 2026-11-19 crash: Safari 17.
    invalid(`URL.canParse("x");`),
    invalid(
      `export const ok = (raw: string) => URL.canParse(raw, "https://a.b");`,
      1,
      CORE_CASE,
    ),
    // A guard on something else guards nothing.
    invalid(`if (typeof fetch === "function") URL.canParse("x");`),
    // A newer method of an old interface, reached through a page global.
    invalid(`document.startViewTransition(() => {});`),
    // A newer global constructor.
    invalid(`new URLPattern({ pathname: "/a" });`),
    // A newer DOM member on an old interface.
    invalid(`document.body.checkVisibility();`),
    // A server file a browser host's worker loads, as the
    // browser-floor:worker-closure check runs the rule on it.
    {
      ...invalid(`URL.canParse("x");`, 1, SERVER_CASE),
      options: [{ shipsToBrowser: true }] as [{ shipsToBrowser?: boolean }],
    },
  ],
});
