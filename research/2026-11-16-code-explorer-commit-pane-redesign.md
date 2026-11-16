# Commit preview pane redesign

## Context

The commit pane (`commit/:worktree/:sha`, `plugins/code-explorer/plugins/commit-detail`) shows a truncated
subject in the pane title, `N files +a −d`, and a hand-rolled list of files with collapsible diffs.
It does not show the commit body, the author, the date, the parent or the provenance trailers. You
cannot narrow the list: a 29-file commit mixes tests, docs and generated files with the code under review.

Prototype: `proto-1794814641-42mwrm` (stacked layout; split is parked). Implementation is pixel-perfect
to it, except that the diff body keeps the `diff-view` primitive's rendering.

The target design:

1. **Message header.**
   - The conventional-commit type and the scopes as chips, then the subject (wrapping, not truncated).
   - A meta row:
     - author and co-author avatars;
     - relative date, with the absolute date in a tooltip;
     - copyable short sha;
     - parent link;
     - branch.
   - The body as prose, clamped, with a "Full message" toggle.
   - The provenance trailers as chips: Conversation, Attempt and Push.
2. **Changed files as a real DataView.**
   - **Saved views as tabs, each with a count:**
     - All files (the default);
     - Code;
     - Tests;
     - Docs.
   - A user-saved custom view gets a dirty dot and a "Save view" action.
   - **Toolbar:**
     - Search.
     - A Kind filter (code, test, doc, generated).
     - Group by: plugin, folder, kind or none.
     - A separate Sort control: most changed, or path.
     - Visible totals, e.g. `23 of 29 +381 −96`.
     - Expand or collapse all.
   - **Group headers** show the count and `+a −d`.
   - **Rows** expand inline to the diff. The open row stays sticky while you scroll its diff.
   - **A footer row** shows `N hidden · <kinds> · Show`.

## Data changes

- **Commit body.**
  - `code.commit-info` (`code-explorer/plugins/code-api/core/commit-values.ts`) returns a
    `CommitDetailSchema`, which is `CommitRowSchema` (`primitives/plugins/commit-list/core/commit-row.ts`)
    extended with `body`.
    - `body` is the message without its subject and without its trailer block.
  - Only `loadCommitInfo` (`code-explorer/machine/internal/commit-values.ts`) asks git for the body. It
    adds `%b` to its own format.
    - The shared `LOG_FORMAT` and `CommitRow` stay lean, because every `git log` list reads them.
  - The trailers are already parsed into `trailers`.
- **File kind.** A pure core classifier, `fileKindOf(path): "code" | "test" | "doc" | "generated"`,
  in a new leaf `code-explorer/plugins/file-kind/core`.
  - Test files: reuse `isTestFilePath` (`tooling/plugins/test-layout/core/test-layout.ts`) and add Go's
    `_test.go`.
  - Generated files: export the generated-artifact patterns once, from `tooling/plugins/codegen/core`.
    - Today they are scattered: the `.gitattributes` `merge=regen-generated` lines, and the private
      `GENERATED_SUFFIX` in `format`.
    - A check asserts that the `.gitattributes` regen patterns and this list agree.
  - Docs: `*.md`.
  - The classifier runs client-side from the path, so there is no wire change.
- **Plugin grouping.** `pluginIdOfRepoPath` / `asPath` (`framework/plugins/plugin-id/core`). A path
  outside `plugins/` groups by its top-level directory.
- **Conventional commit parse** (`type(scopes)!: subject`): search for an existing helper first. If there
  is none, add a small one to `primitives/plugins/commit-list/core`.
- **Trailer keys** (conversation, attempt, push, co-author): reuse the constants that `commit-link` and
  the push ledger already read. The ids render through the id-kind presenters (`conv-` and `att-` chips).

## Data-view primitive changes (`plugins/primitives/plugins/data-view`)

Each change is generic and opt-in, and the commit pane is its first consumer.

1. **Tabs with per-view counts and a dirty dot.**
   - `EditableViewSwitcher` (`plugins/view-core/web/components/editable-view-switcher.tsx`) gains
     `countFor` / `dirtyFor`, the same contract `ViewList` already takes.
   - `DataView` wires `useViewRowCounts` and `viewModel.dirtyFor` into it. Counts appear only where they
     are known (in-memory rows).
2. **Save-view UI for drafts.**
   - Under `viewEdits={{ mode: "draft" }}`, a dirty active tab shows **Save view** (`drafts.save`) and a
     menu offering Save as new and Discard.
   - The `drafts` API exists already, but nothing draws it yet.
3. **Group-by as a promotable setting.**
   - Group-by stays in View settings by default.
   - A new surface option promotes it to its own toolbar pill: `promotedSettings={["group-by"]}`, typed
     against the declared Setting ids.
   - The pill reuses `settings/group-by-control.tsx` inside a panel Control.
   - Sort already has its own control; nothing changes there.
4. **Section summary at rest.**
   - A new `sectionSummary?: (section) => ReactNode` draws a trailing, always-visible cluster in
     `DataViewGroupHeader`, here the `+a −d` sums.
   - It differs from `headerActions`, which appears only on hover.
5. **A sticky row while its detail is open.**
   - In the list view, a row whose `detail` is open joins the section's `StickyStack` under the group
     header until its detail scrolls past.
   - Verify this against `VirtualRows` with tall details.
   - This is default-on for `detail` rows; audit the existing `detail` consumers.
6. **Hidden-by-view footer.**
   - An opt-in `revealHidden` option. For in-memory rows, the count is the rows that pass search but fail
     the active view's filter.
   - It renders `N hidden · <values of the filter field> · Show`. Show writes a cleared filter as a draft.
   - It is omitted for live sources, whose hidden count is unknown.

## commit-detail changes

- **`panes.tsx`.** The pane title becomes `Commit <shortSha>`, because the subject now lives in the body.
  The `useCommitInfo` arms stay.
- **New `components/commit-message.tsx`.** It renders the header from `CommitDetail`.
- **Rewrite `components/commit-diff-view.tsx`** as a `<DataView>`:
  - In-memory `rows` are the `EditedFile`s, enriched with `kind`, `plugin`, `folder` and `churn`.
  - `storageKey = defineDataView("commit-files")`.
  - Fields:
    - path (primary, rendered as dir + base);
    - kind (enum, with icons);
    - plugin;
    - folder;
    - additions and deletions;
    - churn (sortable).
  - `views={["list"]}`.
  - `viewOptions.list.detail = row => <DiffOrImageView …/>` with `detailOnActivate`.
  - `viewEdits={{ mode: "draft", home: "all" }}`, `promotedSettings={["group-by"]}`,
    `sectionSummary`, `revealHidden`.
  - The built-in views (All, Code, Tests, Docs) are filters on `kind`, authored in
    `config/code-explorer/commit-detail/commit-files.jsonc`.
  - It keeps the loading, unavailable, error and truncated ("first 2000") states.
  - The `rail/no-adhoc-band` debt header goes away.
- **Expand / collapse all** is the existing View settings expand-all.

## Verification

- `./equin test` on `plugins/primitives/plugins/data-view` (new switcher counts, promoted setting,
  section summary, hidden footer) and on the `file-kind` classifier.
- `./equin check`, including the new gitattributes ↔ generated-patterns check and the data-view config
  overrides check.
- `./equin build`, then `register_before_after` on
  `/agents/c/<conv>/commit/main/d16b747ce7055b893691c621b7ede3c480d0aa41`.
- `compare-diff.ts --name proto-1794814641-42mwrm` at the pane width.
- With the `browser_*` tools, check:
  - switching tabs;
  - toggling Kind (dirty dot, then Save view);
  - each grouping;
  - the sticky open row;
  - Show on the hidden footer.
- Re-open a commit-link chip and the commits graph to confirm the pane still opens from both consumers.
