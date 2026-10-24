/**
 * Tests for the `no-reactive-server-io` lint rule. Run with
 * `./equin test plugins/framework/plugins/tooling/plugins/lint/plugins/reactive-server-io`.
 *
 * The rule flags server I/O inside a `useEffect` / `useLayoutEffect` that reacts
 * to shared live-state, because every open tab receives the same push and runs
 * the same effect. The shared-state readers are matched by NAME: network/live's
 * `useLive` / `useLiveRow` (which the `use*Resource(s)` convention cannot see),
 * the old `useResource`, and any `use*Resource(s)` hook. An effect that reacts
 * only to local state, or reads a shared value it does not react to, is left
 * alone — the rule favours false negatives.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-reactive-server-io";

// Hand RuleTester bun's own describe/it. Left to find them as globals, it
// registers nothing under `./equin test` ("Ran 0 tests across 1 file"):
// it runs every case inline at module load and stops at the first failure.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

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

const error = { messageId: "reactiveServerIo" as const };

// `RuleTester.run` registers one bun test per case (through the describe/it
// handed to it above), so it must run at module top level.
ruleTester.run(
  "no-reactive-server-io",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The effect reacts to local state only.
      {
        code: `function C() {
          const [n, setN] = useState(0);
          useEffect(() => { toast("n changed"); }, [n]);
        }`,
      },
      // A live value is read, but the effect does not react to it.
      {
        code: `function C() {
          const count = useLive(unreadCount);
          const [open, setOpen] = useState(false);
          useEffect(() => { if (open) toast("opened"); }, [open]);
          return count;
        }`,
      },
      // A live row, read outside the effect's dependencies.
      {
        code: `function C({ id }) {
          const row = useLiveRow(tasks, id);
          useEffect(() => { void fetchEndpoint(ping, {}); }, [id]);
          return row;
        }`,
      },
      // The effect reacts to a live value but performs no server I/O.
      {
        code: `function C() {
          const r = useLive(unreadCount);
          useEffect(() => { document.title = String(r.data); }, [r]);
        }`,
      },
      // Only the exact names are shared-state hooks — `useLiveness` is not `useLive`.
      {
        code: `function C() {
          const alive = useLiveness();
          useEffect(() => { toast("alive"); }, [alive]);
        }`,
      },
    ],
    invalid: [
      // `useLive` over a value, the effect's deps name it directly.
      {
        code: `function C() {
          const unread = useLive(unreadCount);
          useEffect(() => { if (unread.data) toast("new"); }, [unread]);
        }`,
        errors: [error],
      },
      // `useLive` over a collection window, tainted transitively through a binding.
      {
        code: `function C() {
          const result = useLive(eventSources, { where: { enabled: true } });
          const rows = result.pending ? [] : result.data;
          useLayoutEffect(() => { void fetchEndpoint(markSeen, { n: rows.length }); }, [rows]);
        }`,
        errors: [error],
      },
      // `useLiveRow`, and a `.mutate` sink.
      {
        code: `function C({ id }) {
          const task = useLiveRow(tasks, id);
          const save = useMutation();
          useEffect(() => { if (task.found) save.mutate(task.row); }, [task]);
        }`,
        errors: [error],
      },
      // No dependency array: the effect reacts to everything its body references.
      {
        code: `function C({ id }) {
          const task = useLiveRow(tasks, id);
          useEffect(() => { if (task.found) toast(task.row.title); });
        }`,
        errors: [error],
      },
      // The old spellings stay covered.
      {
        code: `function C() {
          const r = useResource(desc);
          useEffect(() => { toast("x"); }, [r]);
        }`,
        errors: [error],
      },
      {
        code: `function C() {
          const r = usePointResources(desc, ids);
          useEffect(() => { void fetch("/x"); }, [r]);
        }`,
        errors: [error],
      },
    ],
  },
);
