/**
 * Tests for the `no-raw-actions-slot` lint rule. Run with `bun test` from the
 * repo root (or this file's directory).
 *
 * The FIRST invalid case is the acceptance test the rule exists for: the tree's
 * `w-0` action cluster from `ee2dfe424`, which rendered `{actions}` inside a
 * `<Clip>` whose className flipped `w-0` → `w-auto` on reveal. It satisfied its
 * predecessor `no-uncoupled-hover-reveal` by adding a `pointer-events` toggle
 * and survived hardened in place. Here it is flagged, and NO edit to the class
 * string — coupling, dropping the class entirely, swapping the wrapper — can
 * clear it, because the rule asks whether the binding reaches `RowActions`.
 */

import rule from "./no-raw-actions-slot";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-raw-actions-slot", rule, {
  valid: [
    // Rendered through the primitive — the one sanctioned form.
    `function Row({ actions }) { return <div><RowActions>{actions}</RowActions></div>; }`,
    // Every placement axis of the primitive.
    `function Cell({ rowActions }) { return <RowActions pin={null}>{rowActions}</RowActions>; }`,
    `function Card({ itemActions }) { return <RowActions pin="top-right">{itemActions}</RowActions>; }`,
    // Conditional inside the primitive.
    `function Row({ actions }) { return <RowActions>{actions ? actions : null}</RowActions>; }`,
    // Guarded render inside the primitive (`&&` — right operand renders).
    `function Row({ actions }) { return <RowActions>{actions && actions}</RowActions>; }`,
    // Fragment inside the primitive.
    `function Row({ actions }) { return <RowActions><>{actions}</></RowActions>; }`,
    // Wrapped INSIDE the primitive — the primitive still owns the reveal on
    // its own outermost node, so any ancestor acquits.
    `function Row({ actions }) { return <RowActions><Stack>{actions}</Stack></RowActions>; }`,
    // Forwarded on as an attribute — a host downstream owns the cluster.
    `function Section({ actions }) { return <Row actions={actions} />; }`,
    `function Section({ actions }) { return <Card rowActions={actions} itemActions={actions} />; }`,
    // Guard only — `actions` is the condition, `<Foo/>` is what renders.
    `function Row({ actions }) { return <div>{actions && <Foo />}</div>; }`,
    // Not rendered at all: an object of callbacks (a DataView's toolbar model).
    `function Toolbar({ actions }) { return <button onClick={() => actions.setSort()} />; }`,
    // A LOCAL named `actions` is not a prop — only destructured props count.
    `function Banner() { const actions = <Remediation />; return <div>{actions}</div>; }`,
    // An object-carried `actions` (graph node descriptor) is a member render,
    // deliberately not tracked.
    `function Node({ data }) { return <div>{data.actions}</div>; }`,
    // A destructure from something that is NOT a parameter of this function.
    `function Row() { const { actions } = useModel(); return <div>{actions}</div>; }`,
    // Nested destructure — a nested object, not a prop.
    `function Row({ config: { actions } }) { return <div>{actions}</div>; }`,
    // Namespaced primitive.
    `function Row({ actions }) { return <Ui.RowActions>{actions}</Ui.RowActions>; }`,
    // COMPOSED, not placed: a fragment stashed in a variable decides nothing
    // about where the cluster sits — the host it is forwarded to does. This is
    // the tree's row-chrome shape (`{actions}{moreMenu}{addChild}`).
    `function RowChrome({ actions }) {
         const trailing = <>{actions}{moreMenu}</>;
         return <TreeRowChrome actions={trailing} />;
       }`,
      // FORWARDED THROUGH CHROME: the wrapper is inside an \`actions=\` attribute,
      // so the host downstream still owns the cluster (SectionCard's shape).
      `function SectionCard({ actions }) {
         return <SectionHeaderRow actions={<ControlSizeProvider size="sm">{actions}</ControlSizeProvider>} />;
       }`,
      // Forwarded under the other two slot names too.
      `function Card({ actions }) { return <Item itemActions={<Sized>{actions}</Sized>} />; }`,
      // A bare pass-through component — its caller places the result.
      `function PassThrough({ actions }) { return <>{actions}</>; }`,
      // The render-prop form routed through the primitive.
      `function Cell({ rowActions, row, index }) { return <RowActions pin={null}>{rowActions(row, index)}</RowActions>; }`,
      // A method CALL on an actions object is not a render of it.
      `function Toolbar({ actions }) { return <div>{actions.render()}</div>; }`,
    ],
    invalid: [
      // ── THE ACCEPTANCE TEST ───────────────────────────────────────────────
      // The `ee2dfe424` duplicate, verbatim in shape: a layout-changing reveal
      // wrapper around a raw `{actions}`. Flagged, and unsatisfiable in place.
      {
        code: `function TreeRowChrome({ actions }) {
          return (
            <Stack>
              {children}
              <Clip className={cn("transition-all", open ? "w-auto" : "w-0")}>{actions}</Clip>
            </Stack>
          );
        }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // The same duplicate after "fixing" it the way its predecessor could be
      // satisfied — coupling pointer-events. Still flagged: the class string is
      // not what this rule reads.
      {
        code: `function TreeRowChrome({ actions }) {
          return <Clip className="opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto">{actions}</Clip>;
        }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Bare in JSX.
      {
        code: `function Row({ actions }) { return <div>{actions}</div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // A fragment INSIDE an element is still a placement — the element is the
      // box that was chosen. (A bare `<>{actions}</>` return is not; see valid.)
      {
        code: `function Row({ actions }) { return <div><>{actions}</></div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Composed into a variable AND placed there — the wrapper settles it, so
      // stashing the JSX in a local is not an escape.
      {
        code: `function Row({ actions }) { const trailing = <Clip>{actions}</Clip>; return <div>{trailing}</div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Forwarded under a NON-actions attribute name — `trailing={…}` is not the
      // slot contract, so the wrapper is a placement.
      {
        code: `function Row({ actions }) { return <Host trailing={<Clip>{actions}</Clip>} />; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Guarded raw render — `{actions && (<Pin>{actions}</Pin>)}`: the guard is
      // not a render, the `<Pin>` child is.
      {
        code: `function Row({ actions }) { return <div>{actions && <Pin>{actions}</Pin>}</div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // The RENDER-PROP form of the slot — data-table's spelling.
      {
        code: `function DataTableRow({ rowActions, row, index }) { return <div className="cell">{rowActions(row, index)}</div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // `rowActions` and `itemActions` are the same slot under other names.
      {
        code: `function TableRow({ rowActions }) { return <span>{rowActions}</span>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      {
        code: `function Item({ itemActions }) { return <Stack>{itemActions}</Stack>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Renaming the local binding is not an escape — the KEY is what's read.
      {
        code: `function Row({ itemActions: acts }) { return <Clip>{acts}</Clip>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Defaulted destructure.
      {
        code: `function Row({ actions = null }) { return <Clip>{actions}</Clip>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // `const { actions } = props` where `props` is this function's parameter.
      {
        code: `function Row(props) { const { actions } = props; return <Clip>{actions}</Clip>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Arrow component.
      {
        code: `const Row = ({ actions }) => <Clip>{actions}</Clip>;`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // A sibling `<RowActions>` elsewhere in the tree does NOT acquit a raw
      // render — only a true ancestor does.
      {
        code: `function Row({ actions }) { return <div><RowActions>{other}</RowActions><Clip>{actions}</Clip></div>; }`,
        errors: [{ messageId: "rawActionsSlot" }],
      },
      // Conditional whose BOTH branches render raw — two reports.
      {
        code: `function Row({ actions }) { return <div>{open ? actions : actions}</div>; }`,
        errors: [
          { messageId: "rawActionsSlot" },
          { messageId: "rawActionsSlot" },
        ],
      },
    ],
  },
);
