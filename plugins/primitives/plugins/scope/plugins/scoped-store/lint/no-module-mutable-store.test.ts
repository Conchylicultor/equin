/**
 * Tests for the `no-module-mutable-store` lint rule. Run with `bun test` from
 * the repo root (or this file's directory).
 *
 * The rule bans a module-scope `let`/`var` whose value is read back by a
 * `useSyncExternalStore` snapshot (the hand-rolled per-surface-singleton
 * anti-pattern), repo-wide. It must NOT fire on a `const` keyed Map/Set whose
 * snapshot reads the keyed collection, on auxiliary module `let`s never returned
 * as the snapshot, or on a bare module `let` with no `useSyncExternalStore`.
 */

import rule from "./no-module-mutable-store";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-module-mutable-store", rule, {
  valid: [
    // KEYED store: the snapshot reads a `const` Map keyed by surface id, not a
    // module `let`. The reference-safe pattern (use-window-geometry).
    {
      code: `
          const geoState = new Map();
          const subscribers = new Set();
          let nextZ = 0;
          function read(tabId) { return geoState.get(tabId); }
          function useGeometry(tabId) {
            return useSyncExternalStore(
              (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
              () => read(tabId),
              () => read(tabId),
            );
          }
        `,
      },
      // Bare module `let` with no useSyncExternalStore — out of scope.
      {
        code: `
          let count = 0;
          export function inc() { count += 1; }
        `,
      },
      // Auxiliary module `let` not returned by the snapshot (snapshot reads the
      // const Map); `hydrated` must NOT be flagged.
      {
        code: `
          const state = new Map();
          let hydrated = false;
          function read(id) { if (!hydrated) hydrated = true; return state.get(id); }
          function useThing(id) {
            return useSyncExternalStore((cb) => () => {}, () => read(id), () => read(id));
          }
        `,
      },
    ],
    invalid: [
      // Canonical anti-pattern: inline arrow snapshot returns the module `let`.
      {
        code: `
          let editMode = false;
          const listeners = new Set();
          function useEditMode() {
            return useSyncExternalStore(
              (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
              () => editMode,
              () => false,
            );
          }
        `,
        errors: [{ messageId: "moduleMutableStore" }],
      },
      // Named getSnapshot identifier resolved one hop to its definition.
      {
        code: `
          let _current = null;
          const _listeners = new Set();
          function getSnapshot() { return _current; }
          function subscribe(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
          function useActive() { return useSyncExternalStore(subscribe, getSnapshot); }
        `,
        errors: [{ messageId: "moduleMutableStore" }],
      },
      // Exported module `let` read by the snapshot — sits at Program via export.
      {
        code: `
          export let snapshot = [];
          const listeners = new Set();
          function useSnap() {
            return useSyncExternalStore((cb) => () => {}, () => snapshot, () => snapshot);
          }
        `,
        errors: [{ messageId: "moduleMutableStore" }],
      },
    ],
  },
);
