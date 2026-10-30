import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-editor/no-adhoc-forest-write",
    paths: ["server/internal/forest-writer.ts"],
    kind: "sanctioned",
    reason:
      "The one module allowed to mutate `page_blocks`. Every export there takes a `PageForestTx`, so the write is provably under its page's lock.",
  },
  {
    rule: "page-editor/no-adhoc-doc-write",
    paths: [
      "web/__tests__",
      "web/internal/block-text-write.ts",
      "web/internal/live-state-yjs-provider.ts",
      "web/internal/local-yjs-provider.ts",
    ],
    kind: "sanctioned",
    reason:
      "The three origins of a block owner's canonical doc, and only them: the replay host, the two transport providers, the binding relay. Tests may stand in for a binding (a local transaction driven straight onto an owner's doc is how a suite types without mounting Lexical).",
  },
  {
    rule: "page-editor/no-unfiltered-blocks-read",
    paths: [
      "server/internal/forest-writer.ts",
      "server/internal/handle-patch-blocks.ts",
      "server/internal/live-blocks.ts",
      "server/internal/page-forest.ts",
      "server/internal/trash-blocks.ts",
    ],
    kind: "sanctioned",
    reason:
      "The modules that must see TRASHED rows: the delete/restore/purge chokepoint, its flag writers, the cascade-set walk (raw SQL), the page-id recompute (raw SQL) and doc-order CTE, the scope resolver (a lock name, never a row), the patch handler's \"which creates land on a trashed row\" lookup, the rank-park floor (a trashed sibling still holds its rank), the pasted-sub-page resolver, and the live relation's own definition.",
  },
  {
    rule: "page-editor/no-unfiltered-blocks-read",
    paths: ["server/internal/page-clipboard.ts"],
    kind: "sanctioned",
    reason:
      "A pasted sub-page: a cut page is in the trash when its paste claims it, and a copy of a since-deleted page still clones what it held.",
  },
  {
    rule: "page-editor/no-adhoc-structural-write",
    paths: ["web/block-store.ts", "web/composite-block-store.tsx"],
    kind: "sanctioned",
    reason:
      "The two modules allowed to call the structural endpoints: the page's own optimistic instance, and the composite router that fans writes out to it (and owns the two lane-enqueued writes that carry no overlay).",
  },
  {
    rule: "page-editor/no-unhistoried-block-field",
    paths: ["web/components/block-text-area.tsx"],
    kind: "sanctioned",
    reason:
      "The one module allowed to render a raw block textarea: it IS the sanctioned surface, and it records every typing run onto the document stack itself. Everything else in `plugins/page/**/web` takes one of the two answers the rule's message names.",
  },
  {
    rule: "sortable-list/no-raw-dnd-kit",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "The page editor's block drag: droppable gaps between blocks plus a `DragOverlay` preview — not a sortable list.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables-events.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/index.ts", "check/no-token-identity-outside-owner.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;
