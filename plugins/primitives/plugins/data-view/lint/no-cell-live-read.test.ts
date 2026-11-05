/**
 * Tests for the `no-cell-live-read` lint rule: a DataView field's `cell` /
 * `token` that reads live data per row — calling `useLive` itself, or
 * rendering a same-file component that does — is flagged; a `rowRead` field,
 * a cell rendering a component with no live read, and a component imported
 * from elsewhere are left alone.
 */

import rule from "./no-cell-live-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-cell-live-read", rule, {
  valid: [
    // A cell drawing a plain component.
    `function Size({ n }) { return <span>{n}</span>; }
     const f = { id: "size", cell: (r) => <Size n={r.size} /> };`,
    // The read declared on the field: `rowRead`'s `cell` gets the read.
    `function FolderSize({ peek }) { return <span>{peek.status}</span>; }
     const f = { id: "size", rowRead: rowRead({ value: v, params: (r) => ({ path: r.path }), cell: (r, peek) => <FolderSize peek={peek} /> }) };`,
    // A component imported from another file is not followed.
    `import { Peeked } from "./peeked";
     const f = { id: "size", cell: (r) => <Peeked path={r.path} /> };`,
    // A component reading live data, rendered outside any cell.
    `function Header() { const x = useLive(v); return <h1>{x.status}</h1>; }
     const el = <Header />;`,
  ],
  invalid: [
    // A cell rendering a same-file component that calls useLive.
    {
      code: `function FolderSize({ path }) { const peek = useLive(hostFsDirPeek, { path }); return <span>{peek.status}</span>; }
             const f = { id: "size", cell: (r) => r.kind === "dir" ? <FolderSize path={r.path} /> : null };`,
      errors: [{ messageId: "cellLiveRead" }],
    },
    // An arrow component, via `token`.
    {
      code: `const Chip = ({ id }) => { const row = useLive(c, { id }); return <b>{row.status}</b>; };
             const f = { id: "who", token: (r) => <Chip id={r.id} /> };`,
      errors: [{ messageId: "cellLiveRead" }],
    },
    // useLive called in the cell function itself.
    {
      code: `const f = { id: "x", cell: function Cell(r) { const v = useLive(c, { id: r.id }); return v.status; } };`,
      errors: [{ messageId: "cellLiveRead" }],
    },
  ],
});
