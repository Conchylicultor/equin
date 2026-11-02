/**
 * Tests for the `no-reactive-server-io` lint rule. Run with
 * `./equin test plugins/framework/plugins/tooling/plugins/lint/plugins/reactive-server-io`.
 *
 * The rule flags server I/O inside a `useEffect` / `useLayoutEffect` that reacts
 * to shared live-state, because every open tab receives the same push and runs
 * the same effect. The shared-state readers are matched by NAME: network/live's
 * `useLive` (which the `use*Resource(s)` convention cannot see),
 * the old `useResource`, and any `use*Resource(s)` hook. An effect that reacts
 * only to local state, or reads a shared value it does not react to, is left
 * alone — the rule favours false negatives.
 */

import rule from "./no-reactive-server-io";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const error = { messageId: "reactiveServerIo" as const };

ruleTester.run("no-reactive-server-io", rule, {
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
          const row = useLive(tasks, { id });
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
      // A row read (`useLive(c, { id })`), and a `.mutate` sink.
      {
        code: `function C({ id }) {
          const task = useLive(tasks, { id });
          const save = useMutation();
          useEffect(() => { if (task.found) save.mutate(task.row); }, [task]);
        }`,
        errors: [error],
      },
      // No dependency array: the effect reacts to everything its body references.
      {
        code: `function C({ id }) {
          const task = useLive(tasks, { id });
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
