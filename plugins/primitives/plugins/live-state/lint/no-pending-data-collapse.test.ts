/**
 * Tests for the `no-pending-data-collapse` lint rule. Run with `bun test` from
 * the repo root (or this file's directory).
 *
 * The rule bans `result.pending ? <emptyDefault> : result.data` on resource
 * results, but must NOT fire on the sanctioned `select`-based point reads
 * (`useResource(…, { select })`), on untainted objects that merely have a
 * `.pending` field, or on render ternaries whose pending branch is real UI.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-pending-data-collapse";

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

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level —
// never wrapped in a `test()` callback.
ruleTester.run(
  "no-pending-data-collapse",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A slot order whose loading arm renders a real loading state.
      {
        code: `
          const order = useSlotOrder(Header.Item);
          const node = order.status !== "ready" ? renderSkeleton() : order.data.length;
        `,
      },
      // Sanctioned select-based point read — the carve-out.
      {
        code: `
          const q = useResource(conversationsResource, undefined, { select });
          const row = q.pending ? null : q.data;
        `,
      },
      // Untainted object with a pending field — not a resource result.
      {
        code: `
          const upload = { pending: true, data: [] };
          const x = upload.pending ? [] : upload.data;
        `,
      },
      // Pending branch is real UI, not an empty default.
      {
        code: `
          const r = useResource(songsResource);
          const node = r.pending ? renderSkeleton() : r.data.length;
        `,
      },
      // Early return — the sanctioned narrowing shape.
      {
        code: `
          function C() {
            const r = useResource(songsResource);
            if (r.pending) return null;
            return r.data.length;
          }
        `,
      },
      // Settled branch doesn't touch .data.
      {
        code: `
          const r = useResource(songsResource);
          const label = r.pending ? "" : "ready";
        `,
      },
      // Statement form, null early-return where the settled value is never
      // nullish — `null` stays a distinct "not yet" the caller must check.
      {
        code: `
          function useThing() {
            const r = useResource(songsResource);
            if (r.pending) return null;
            return r.data;
          }
        `,
      },
      // Statement form in a COMPONENT — the data-return is JSX, so the function
      // renders UI once loaded. The non-JSX guard keeps it green even though it
      // early-returns null while pending.
      {
        code: `
          function C() {
            const q = useResource(songsResource);
            if (q.pending) return null;
            return <div>{q.data}</div>;
          }
        `,
      },
      // Statement form, NON-EMPTY sentinel default — a deliberate sentinel, not a
      // fake-empty collapse, so it is legitimate (file-peek's \`?? "clean"\`).
      {
        code: `
          function useStatus(id) {
            const q = useResource(tasksResource);
            if (q.pending) return "clean";
            return q.data.find((t) => t.id === id)?.status ?? "clean";
          }
        `,
      },
      // Statement form on a sanctioned select-based point read — carve-out holds.
      {
        code: `
          function useRow(id) {
            const q = useResource(conversationsResource, undefined, { select });
            if (q.pending) return [];
            return q.data;
          }
        `,
      },
      // Statement form where the later return doesn't touch .data — no collapse.
      {
        code: `
          function useLabel() {
            const r = useResource(songsResource);
            if (r.pending) return "";
            return "ready";
          }
        `,
      },
      // Same, with a derivation that can't produce null.
      {
        code: `
          function useCount() {
            const r = useResource(songsResource);
            if (r.pending) return null;
            return r.data.length;
          }
        `,
      },
      // A `null` inside a nested callback doesn't make the return nullable.
      {
        code: `
          function useNames() {
            const r = useResource(songsResource);
            if (r.pending) return null;
            return r.data.map((s) => s.name ?? null);
          }
        `,
      },
      // A hook handing its caller the result itself — the pending arm survives.
      {
        code: `
          function useProgress(ids) {
            const r = useLive(progressRows, { ids });
            return r;
          }
        `,
      },
      // A component rendering nothing while an id read loads — sanctioned,
      // even though its JSX reads a nullable row.
      {
        code: `
          function Chip({ id }) {
            const r = useLive(progressRows, { ids: [id] });
            if (r.pending) return null;
            return <span>{r.data[0]?.phase}</span>;
          }
        `,
      },
      // A pane title hook: undefined means "show the title's fallback", which is
      // right while loading too.
      {
        code: `
          function useDeploymentTitle({ id }) {
            const result = useResource(deploymentsResource);
            if (result.pending) return undefined;
            return result.data.find((d) => d.id === id)?.name;
          }
          export const pane = Pane.define({
            title: { useText: useDeploymentTitle, fallback: "Deployment" },
          });
        `,
      },
      // Same, written inline.
      {
        code: `
          export const pane = Pane.define({
            title: {
              useText: ({ id }) => {
                const r = useLive(rows, { ids: [id] });
                return r.pending ? undefined : r.data[0]?.name;
              },
              fallback: "Row",
            },
          });
        `,
      },
    ],
    invalid: [
      // A slot's layout order is a read: collapsing its loading arm to the
      // empty list (or to the raw contributions) is the first-paint flash.
      {
        code: `
          const order = useSlotOrder(Header.Item);
          const items = order.status !== "ready" ? [] : order.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      {
        code: `
          const state = useReorderedEntries("my.slot", contributions);
          const entries = state.status === "ready" ? state.data : [];
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      {
        code: `
          const order = useLayoutOrder(slot, contributions);
          const xs = order.status !== "ready" ? [] : order.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      {
        code: `
          const z = useZStackIndex("toaster");
          const index = z.status === "ready" ? z.data : 0;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // The `status` spelling of the same collapse — both branch orders.
      {
        code: `
          const r = useLive(rows);
          const xs = r.status !== "ready" ? [] : r.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      {
        code: `
          const r = useLive(rows);
          const xs = r.status === "ready" ? r.data : [];
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // …and its statement form.
      {
        code: `
          function useRows() {
            const r = useResource(rowsResource);
            if (r.status !== "ready") return [];
            return r.data;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // A title hook returning null (not the contract's undefined) is still flagged.
      {
        code: `
          function useTitle2({ id }) {
            const result = useLive(rows, { ids: [id] });
            if (result.pending) return null;
            return result.data[0]?.name ?? null;
          }
          export const pane = Pane.define({ title: { useText: useTitle2 } });
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // A `useText:` hook outside a `title: { … }` object is not a pane title hook.
      {
        code: `
          function useLabel2({ id }) {
            const result = useLive(rows, { ids: [id] });
            if (result.pending) return undefined;
            return result.data[0]?.name;
          }
          export const chip = defineChip({ label: { useText: useLabel2 } });
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // An id read collapsed by a ternary: pending and absent are both null.
      {
        code: `
          function useProgressFor(id) {
            const result = useLive(progressRows, { ids: [id] });
            return result.pending ? null : (result.data[0] ?? null);
          }
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // An id set narrowed to one row: `?? null` makes the settled value nullable.
      {
        code: `
          function useTaskAutoStart(ids) {
            const result = useLive(autoStartRows, { ids });
            if (result.pending) return null;
            return result.data[0] ?? null;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // Whole-collection lookup with an optional chain + `?? null`.
      {
        code: `
          function useTaskEffort(taskId) {
            const result = useResource(taskEffortsResource);
            if (!taskId) return null;
            if (result.pending) return null;
            return result.data[taskId]?.level ?? null;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // An id set collapsed to undefined by a ternary.
      {
        code: `
          function useRows(ids) {
            const result = useLive(categories, { ids });
            const rows = result.pending ? undefined : result.data;
            return rows;
          }
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // A hook returning a window read collapsed to an empty list.
      {
        code: `
          function useStarred() {
            const result = useLive(starredPages);
            return result.pending ? [] : result.data;
          }
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // A live collection read collapsed to an empty list.
      {
        code: `
          const sources = useLive(eventSources);
          const rows = sources.pending ? [] : sources.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // A live VALUE read collapsed to a zero count.
      {
        code: `
          const unread = useLive(notificationsUnread);
          const count = unread.pending ? 0 : unread.data.errors;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // The canonical collapse.
      {
        code: `
          const r = useResource(songsResource);
          const rows = r.pending ? [] : r.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Negated test, branches swapped.
      {
        code: `
          const r = useResource(songsResource);
          const rows = !r.pending ? r.data : [];
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Other empty defaults: null / false / 0 / {} and nested .data access.
      {
        code: `
          const r = useResource(pushesResource);
          const hasPush = r.pending ? false : r.data.some((p) => p.id === id);
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      {
        code: `
          const r = useResource(tasksResource);
          const t = r.pending ? null : r.data.find((t) => t.id === id);
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Cast empty default (`[] as Foo[]`).
      {
        code: `
          const r = useResource(tasksResource);
          const rows = r.pending ? ([] as Task[]) : r.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Hoisted empty-const default.
      {
        code: `
          const EMPTY = [];
          const r = useResource(tasksResource);
          const rows = r.pending ? EMPTY : r.data;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Optimistic results are tainted too.
      {
        code: `
          const r = useOptimisticResource(queueRanks, { ids }, { apply, mutate });
          const ranks = r.pending ? [] : r.data.map((row) => row.rank);
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Combined results are tainted too.
      {
        code: `
          const all = useCombinedResources({ a, b });
          const rows = all.pending ? [] : all.data.a;
        `,
        errors: [{ messageId: "pendingCollapse" }],
      },
      // Statement form, bare empty default — the textbook \`useEditedFiles\` shape.
      {
        code: `
          function useFiles() {
            const r = useResource(filesResource);
            if (r.pending) return [];
            return r.data;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // Statement form, WRAPPED empty parallel to the data-return.
      {
        code: `
          function useEditedFiles() {
            const result = useResource(editedFilesResource);
            if (result.pending) return { files: [] };
            return { files: result.data };
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // Statement form, block-body consequent (single return inside braces).
      {
        code: `
          function useFiles() {
            const r = useResource(filesResource);
            if (r.pending) {
              return [];
            }
            return r.data;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // Statement form on an optimistic result — tainted too.
      {
        code: `
          function useRanks() {
            const r = useOptimisticResource(queueRanksValue, { apply, mutate });
            if (r.pending) return [];
            return r.data.ranks;
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
      // Statement form on a combined result — tainted too.
      {
        code: `
          function useRows() {
            const all = useCombinedResources({ a, b });
            if (all.pending) return { rows: [] };
            return { rows: all.data.a };
          }
        `,
        errors: [{ messageId: "pendingCollapseReturn" }],
      },
    ],
  },
);
