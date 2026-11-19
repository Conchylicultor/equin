import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "data-view/no-adhoc-row-list",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "These primitives ARE the row-rendering machinery (DataView's own list/table/tree views, the tree primitive, and the reorder editor), so mapping into <Row> is their implementation.",
  },
  {
    rule: "live/visible-range-minter",
    paths: ["web/internal/pages-viewport.ts"],
    kind: "sanctioned",
    reason:
      "The one place a paged read's viewport is minted: data-view measures the rows a DataView draws, and useLivePagesPaging hands the sink that feeds it out inside the paging the DataView takes.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/creators-control.tsx",
      "web/internal/collection-item-actions.tsx",
      "web/internal/collection-row-activation.tsx",
      "web/internal/define-item-actions.tsx",
      "web/internal/derived-fields.tsx",
      "web/internal/field-extensions.tsx",
      "web/internal/live-source.tsx",
      "web/internal/live-tree/use-live-tree.tsx",
      "web/internal/row-reads.tsx",
      "web/internal/use-filter-presets.ts",
      "web/internal/use-item-action-zones.tsx",
      "web/internal/use-sort-presets.ts",
      "web/internal/use-visible-row-keys.ts",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — creators-control.tsx: CreatorsControl (unsupported syntax: Handle TryStatement without a catch clause); collection-item-actions.tsx: useCollectionItemActions (calls a hook inside a function expression); collection-row-activation.tsx: ActivationLevel (calls a hook carried as a value); define-item-actions.tsx: ItemActionCell (passes a hook around as a value); derived-fields.tsx: FieldOptionsLevel (calls a hook carried as a value); field-extensions.tsx: FieldExtensionFold (calls a hook carried as a value); live-source.tsx: useLiveSource (unsupported syntax: Support value blocks (conditional, logical, optional chaining, etc) within a try/catch statement); use-live-tree.tsx: useLiveTree (unsupported syntax: Handle ??= operators in AssignmentExpression); row-reads.tsx: ReadValueField (passes a hook around as a value); use-filter-presets.ts: useFilterPresets (its hand-written memoization cannot be preserved); use-item-action-zones.tsx: useItemActionZones (passes a hook around as a value); use-sort-presets.ts: useSortPresets (its hand-written memoization cannot be preserved); use-visible-row-keys.ts: useVisibleRowKeys (unsupported syntax: Handle ??= operators in AssignmentExpression).",
  },
] satisfies Exemptions;
