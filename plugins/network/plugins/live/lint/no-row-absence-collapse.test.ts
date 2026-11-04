/**
 * Tests for the `no-row-absence-collapse` lint rule: a by-id row read whose
 * not-found arm is folded into its loading arm.
 */

import rule from "./no-row-absence-collapse";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const value = { messageId: "valueCollapse" as const };
const loading = { messageId: "absentAsLoading" as const };

ruleTester.run("no-row-absence-collapse", rule, {
  valid: [
    // Each arm its own answer.
    {
      code: `
        function f(r) {
          switch (r.status) {
            case "loading": return { kind: "pending" };
            case "error": return { kind: "failed" };
            case "ready": return r.found ? { kind: "row", row: r.row } : { kind: "absent" };
          }
        }`,
    },
    // A component rendering nothing in both arms makes a render choice.
    {
      code: `
        function Chip({ r }) {
          if (r.status === "loading") return null;
          return r.found ? <Item row={r.row} /> : null;
        }`,
    },
    // `found` alone, with no loading arm folded into the same value.
    { code: `const label = r.found ? r.row.title : "Gone";` },
    {
      code: `
        function f(r) {
          if (r.status === "loading") return "…";
          return r.found ? r.row.title : null;
        }`,
    },
    // The loading arm renders nothing; the found test feeds a later render.
    {
      code: `
        function Chip({ r }) {
          let target;
          switch (r.status) {
            case "loading": return null;
            case "ready": target = r.found ? r.row : undefined;
          }
          return target ? <A t={target} /> : <Missing />;
        }`,
    },
    // Not found rendered as its own state.
    {
      code: `const el = r.found ? <Detail row={r.row} /> : <Placeholder>Gone</Placeholder>;`,
    },
    {
      code: `<ResourceView resource={x}>{(a) => (a ? <Detail a={a} /> : <Missing />)}</ResourceView>;`,
    },
    // A <Loading> for ANOTHER read inside a ready callback.
    {
      code: `<ResourceView resource={x}>{(a) => { if (other.status === "loading") return <Loading />; return <D a={a} />; }}</ResourceView>;`,
    },
  ],
  invalid: [
    // useConversationById's old shape.
    {
      code: `
        function useById(id) {
          const row = useLive(c, { id });
          switch (row.status) {
            case "loading":
              return null;
            case "error":
              return row.stale ?? null;
            case "ready":
              return row.found ? row.row : null;
          }
        }`,
      errors: [value],
    },
    {
      code: `
        function f(r) {
          if (r.status !== "ready") return undefined;
          return r.found ? r.row.name : undefined;
        }`,
      errors: [value],
    },
    // Fall-through cases.
    {
      code: `
        function f(r) {
          switch (r.status) {
            case "loading":
            case "error":
              return null;
            case "ready":
              return r.found ? r.row : null;
          }
        }`,
      errors: [value],
    },
    // The ready-gated conditional folds loading in on its own.
    {
      code: `const kind = row.status === "ready" && row.found ? row.row.kind : undefined;`,
      errors: [value],
    },
    // AgentDetail's old shape: mapRow's null drawn as loading.
    {
      code: `
        <ResourceView resource={agentResult}>
          {(agent) => {
            if (!agent) return <Loading />;
            return <Inner agent={agent} />;
          }}
        </ResourceView>;`,
      errors: [loading],
    },
    {
      code: `matchResource(r, { ready: (c) => { if (c === null) { return <Loading />; } return <C c={c} />; } });`,
      errors: [loading],
    },
    {
      code: `function C({ r }) { if (!r.found) return <Loading />; return null; }`,
      errors: [loading],
    },
    {
      code: `const el = r.found ? <D row={r.row} /> : <Loading variant="text" />;`,
      errors: [loading],
    },
  ],
});
