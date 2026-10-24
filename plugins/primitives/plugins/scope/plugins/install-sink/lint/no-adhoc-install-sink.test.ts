/**
 * Tests for the `no-adhoc-install-sink` lint rule. Run with
 * `./equin test plugins/primitives/plugins/install-sink`.
 *
 * The rule bans a module-scope `let`/`var` written by an exported
 * `set*`/`install*`/`register*` function and read elsewhere, in a WEB-runtime
 * file that has NO subscription path — a sink with no way to subscribe. It must
 * NOT fire outside `web/` (no render path there, so the message would be false),
 * on a file with any subscription path (a `useSyncExternalStore`, an exported
 * `subscribe…`, or a `Set<() => void>` of listeners), on a module `let` with no
 * such writer, on a write-only binding, or on a `const` registry.
 *
 * Every case carries an explicit `filename`, since the web-runtime guard reads
 * it — a case without one tests nothing.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-adhoc-install-sink";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

// Fixture paths name THIS plugin rather than an invented one: the
// `plugin-refs-resolve` check validates every plugin-path string literal in the
// repo, so a fictional one fails the build. Only the runtime segment
// (`web/` vs `server/`/`core/`) is what these fixtures are actually varying.
/** A web-runtime path — in scope. */
const WEB =
  "plugins/primitives/plugins/scope/plugins/install-sink/web/internal/store.ts";

ruleTester.run(
  "no-adhoc-install-sink",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // --- (0) The web-runtime guard ------------------------------------------
      // The incident's exact shape, in `server/` — no render path exists there, so
      // the rule's message would be a lie. Same for `core/` and build-time code.
      {
        filename:
          "plugins/primitives/plugins/scope/plugins/install-sink/server/internal/resource.ts",
        code: `
        let configGetter = null;
        export function setConfigGetter(fn) { configGetter = fn; }
        export function readConfig() { return configGetter; }
      `,
      },
      {
        filename:
          "plugins/primitives/plugins/scope/plugins/install-sink/core/registry.ts",
        code: `
        let hooks = null;
        export function registerHooks(next) { hooks = next; }
        export function readHooks() { return hooks; }
      `,
      },

      // --- (1) Any subscription path ------------------------------------------
      // A `useSyncExternalStore` in the same file (also covered by
      // scoped-store/no-module-mutable-store, which owns that half).
      {
        filename: WEB,
        code: `
        let adapter = null;
        const listeners = new Set();
        export function setAdapter(next) {
          adapter = next;
          listeners.forEach((l) => l());
        }
        export function useAdapter() {
          return useSyncExternalStore(
            (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
            () => adapter,
          );
        }
      `,
      },
      // A store split across files: the `useSyncExternalStore` lives in the
      // consumer, so the subscription path shows here as the exported
      // `subscribe…` (improve/web/internal/open-store.ts is this shape).
      {
        filename: WEB,
        code: `
        let state = { open: false };
        const listeners = new Set();
        export function setImproveOpen(open) {
          state = { open };
          for (const l of listeners) l();
        }
        export function subscribeImproveOpen(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        }
        export function getImproveOpenState() { return state; }
      `,
      },
      // The listener collection alone, typed on the `new Set<…>()` call.
      {
        filename: WEB,
        code: `
        let state = null;
        const listeners = new Set<() => void>();
        export function setState(next) {
          state = next;
          for (const l of listeners) l();
        }
        export function readState() { return state; }
      `,
      },
      // The same collection, typed on the declaration instead.
      {
        filename: WEB,
        code: `
        let state = null;
        const listeners: Set<() => void> = new Set();
        export function setState(next) {
          state = next;
          for (const l of listeners) l();
        }
        export function readState() { return state; }
      `,
      },

      // --- (2)/(3) Shape ------------------------------------------------------
      // No set*/install*/register* exported writer.
      {
        filename: WEB,
        code: `
        let count = 0;
        export function bump() { count += 1; }
        export function read() { return count; }
      `,
      },
      // The writer's binding is never read anywhere else — a write-only slot.
      {
        filename: WEB,
        code: `
        let adapter = null;
        export function setAdapter(next) { adapter = next; }
      `,
      },
      // A `const` keyed registry Map is not a mutable slot.
      {
        filename: WEB,
        code: `
        const registry = new Map();
        export function registerThing(id, value) { registry.set(id, value); }
        export function getThing(id) { return registry.get(id); }
      `,
      },
      // The writer is not exported.
      {
        filename: WEB,
        code: `
        let adapter = null;
        function setAdapter(next) { adapter = next; }
        export function getAdapter() { return adapter; }
      `,
      },
      // A lowercase-after-prefix name (`settle`) is not a writer.
      {
        filename: WEB,
        code: `
        let pending = null;
        export function settle(next) { pending = next; }
        export function getPending() { return pending; }
      `,
      },
      // A `Set` of something other than nullary void functions is not a listener
      // collection — the file is still in scope, but this one has no writer.
      {
        filename: WEB,
        code: `
        const ids = new Set<string>();
        export function readIds() { return ids; }
      `,
      },
    ],
    invalid: [
      // The incident's shape, verbatim.
      {
        filename: WEB,
        code: `
        let appNavigator = null;
        export function setAppNavigator(fn) { appNavigator = fn; }
        export function canNavigateApp() { return appNavigator !== null; }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
      // `install*` writer, arrow form, read from module scope.
      {
        filename: WEB,
        code: `
        let fallback = null;
        export const installOverlayFallback = (next) => { fallback = next; };
        export function renderFallback(props) { return fallback ? fallback(props) : null; }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
      // `register*` writer, `var` binding.
      {
        filename: WEB,
        code: `
        var liveStore = null;
        export function registerLiveStore(store) { liveStore = store; }
        export function readStore() { return liveStore; }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
      // Exported `let` binding (declaration sits under the export).
      {
        filename: WEB,
        code: `
        export let adapter = null;
        export function setAdapter(next) { adapter = next; }
        export function describe() { return String(adapter); }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
      // A `Set` in the file that is NOT a listener collection does not exempt it.
      {
        filename: WEB,
        code: `
        const seen = new Set<string>();
        let adapter = null;
        export function setAdapter(next) { adapter = next; }
        export function getAdapter() { return seen.size ? adapter : null; }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
      // The root `web/` bootstrap is the web runtime too.
      {
        filename: "web/src/boot-adapter.ts",
        code: `
        let adapter = null;
        export function setAdapter(next) { adapter = next; }
        export function getAdapter() { return adapter; }
      `,
        errors: [{ messageId: "adhocInstallSink" }],
      },
    ],
  },
);
