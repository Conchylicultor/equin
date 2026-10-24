# Loading-state fix — closing the statement-form gap

## Context

The v2 loading-state structural fix (`research/2026-06-11-global-loading-pending-defaults-v2.md`)
shipped a `Loading` primitive, the `combineResources`/`matchResource`/`ResourceView`
gate combinators, `DataView` loading-awareness, and a lint rule
`no-pending-data-collapse` meant to make the "collapse `pending` into a fake
empty state" bug class **impossible to reintroduce**. The ternary BURNDOWN is
now complete and the allowlist is empty.

But a user hit the original symptom again: opening a conversation, the
**Push & Exit** button flickers **"Drop & Exit" → "Push & Exit"** while data
loads. Investigation found two gaps the v2 fix left open:

- **Gap 1 (structural).** The lint rule has only a `ConditionalExpression`
  visitor — it catches the ternary `x.pending ? <empty> : x.data` form but **not**
  the early-return statement form `if (x.pending) return <empty-default>`. That
  form exists in 37 files / 39 sites today and is completely uncovered — not even
  burndown-listed. `useEditedFiles`
  (`plugins/conversations/plugins/conversation-view/plugins/code/web/use-edited-files.ts:9`)
  is the textbook case: `if (result.pending) return { files: [] }`.
- **Gap 2 (instance).** The Push & Exit button reads **three** independently-
  arriving resources (pushes, sibling, edited-files) but the v2 reference fix
  gated only two. The `files.length > 0` branch
  (`push-and-exit-button.tsx:112`) sits *above* the gate and reads `files`
  collapsed-to-`[]` while pending, so the mode falls through to the destructive
  `drop-and-exit` default until `editedFilesResource` settles.

**Outcome:** extend the rule to the statement form, eliminate the
`useEditedFiles` collapse by returning a gateable result, fold `files` into the
Push & Exit gate, and migrate the other five `useEditedFiles` callers. Full
migration of the remaining statement-form population is a **follow-up**, mirroring
the v2 PR's "ship rule + fix reference sites" scoping.

**Confirmed decisions (user):**
- Gap 2 scope = **fix the hook + all 6 callers** (not just gate push-and-exit).
- `null`/`undefined` early-returns are **excluded** from the rule (they signal
  absence the caller must null-check; flagging them creates noise and breaks the
  legitimate render-nothing-while-loading pattern).

---

## Gap 1 — extend `no-pending-data-collapse` to the statement form

File: `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts`
(reuse existing helpers: `pendingAccessOf`, `isResourceResultBinding`,
`isEmptyDefaultLiteral`, `referencesData`, `unwrap`, `initializerOf`).

Add an **`IfStatement` visitor** (same rule id — this is the same conceptual ban,
a second syntactic form). Flag when ALL hold:

1. `node.test` is `<x>.pending` (via `pendingAccessOf`).
2. `x` is a resource-result binding (`isResourceResultBinding` — keeps the
   `useResource(…, { select })` carve-out).
3. The consequent (a `ReturnStatement`, or a `BlockStatement` whose only
   statement is one) returns a **typed-empty data stand-in** — defined as: the
   data-return value with every `x.data` position replaced by an empty literal
   (`[]`, `{}`, `0`, `""`, `false`) — i.e. either
   - a bare empty default literal **excluding `null`/`undefined`** (a
     null-excluding variant of `isEmptyDefaultLiteral`), or
   - a **wrapped empty** structurally parallel to the data-return:
     `{ files: [] }` against a data-return of `{ files: x.data }` (same keys;
     each key's value is an empty literal where the data-return references
     `x.data`).
4. The enclosing function has a **subsequent `ReturnStatement`** whose argument
   (a) references `<x>.data` (`referencesData`) **and** (b) is **not** a
   `JSXElement`/`JSXFragment` — i.e. the function produces a consumable value
   (a hook/derivation), not a render. JSX data-returns are components rendering
   real UI once loaded and are never flagged.

Report on the `if` node with a **new messageId** `pendingCollapseReturn` steering
to: expose the raw `ResourceResult` and gate at the caller (hooks), early-return
`<Loading/>` (components), or `combineResources` (multi-resource). Reuse the
`pendingCollapse` message's spirit, tailored to the statement form.

Why these guards keep false positives out:
- `null`/`undefined` excluded → existing valid case `if (r.pending) return null`
  stays green; component "render nothing while loading" untouched.
- JSX data-return excluded → `if (q.pending) return null; return <div>{q.data}</div>`
  untouched.
- Non-empty literal defaults untouched → `file-peek-pane`'s `?? "clean"` and any
  deliberate sentinel default are legitimate.

**Fixtures** (`no-pending-data-collapse.test.ts`, same RuleTester/`tsParser`
setup): add **invalid** — `if (r.pending) return { files: [] }; return { files: r.data };`
and `if (r.pending) return []; return r.data;`; add **valid** —
`if (q.pending) return null; return <div>{q.data}</div>` (component),
`if (q.pending) return "clean"; return q.data.find(...)?.status ?? "clean"`
(non-empty default), and the existing select carve-out. Run with
`bun test plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.test.ts`.

**BURNDOWN reopen:** the new visitor will flag a subset of the 37 statement-form
files (the hook/derivation collapses, e.g. `use-*.ts` returning typed-empty
data). Fix `useEditedFiles` in this PR (Gap 2). For any *other* genuine hits,
seed `ignores["no-pending-data-collapse"]` in
`plugins/primitives/plugins/live-state/lint/index.ts` with their file globs and
revise the "BURNDOWN COMPLETE / do not add" comment to document a **new
statement-form wave**, then file the follow-up task to drain it. (Exact glob list
is determined by running `./equin check eslint` after the rule lands —
component `return null`/JSX hits won't appear.)

## Gap 2 — make `useEditedFiles` gateable + fix all callers

**Hook** — `…/code/web/use-edited-files.ts`: drop the collapse; return the raw
discriminated union (mirrors `useHasActiveSiblings` returning
`ResourceResult<boolean>`):

```ts
export function useEditedFiles(conversationId: string): ResourceResult<EditedFile[]> {
  return useResource(editedFilesResource, { id: conversationId });
}
```

`editedFilesResource` is a plain (non-`select`) `resourceDescriptor`, so its
result feeds gates directly — no `gate: true` needed.

**Callers (6):**

1. **`push-and-exit-button.tsx`** (the bug) — fold into the existing gate and
   move the data-dependent branches below it:
   ```ts
   const filesResult = useEditedFiles(convId);
   const exitDecision = useCombinedResources({
     pushes: pushesResult, hasSibling: siblingResult, files: filesResult,
   });
   // in useMemo, after restore/send/stop checks:
   if (exitDecision.pending) return { mode: "exit", provisional: true };
   const { pushes, hasSibling, files } = exitDecision.data;
   if (files.length > 0) {
     if (files.every((f) => f.path.startsWith("research/"))) return { mode: "go", provisional: false };
     return { mode: "push-and-exit", provisional: false };
   }
   const hasPush = pushes.some((p) => p.attemptId === conversation.attemptId);
   if (hasPush) return { mode: "exit", provisional: false };
   return { mode: hasSibling ? "exit" : "drop-and-exit", provisional: false };
   ```
   Update the memo deps (`exitDecision` replaces the separate `files`).
2. **`code-review-section.tsx`** (`WorkingTreeBody`) — `FileList` already takes
   `EditedFile[] | null` and renders `<Loading/>` on `null`. Wrap:
   ```tsx
   const filesResult = useEditedFiles(conversationId);
   return (
     <ResourceView resource={filesResult} fallback={<FileList files={null} worktree={worktree} base="main" emptyLabel="No edited files." />}>
       {(files) => <FileList files={files} worktree={worktree} base="main" emptyLabel="No edited files." />}
     </ResourceView>
   );
   ```
   (`emptyLabel` now shows only on confirmed-empty — no empty→files flicker.)
3. **`code-review-summary.tsx`** — already early-returns on `pushesQ.pending`;
   add a second gate for files (consistent style):
   `const filesResult = useEditedFiles(conversationId); … if (filesResult.pending) return null;`
   then `const files = filesResult.data;`.
4. **`docs-button.tsx`** — early-return a neutral (disabled) button while
   `filesResult.pending`; otherwise `const files = filesResult.data;` and compute
   `workingDocs`/`count` as today.
5. **`docs-pane.tsx`** (`DocsPaneInner`) — `if (filesResult.pending) return <PaneChrome pane={convDocsPane} title="Docs"><Loading/></PaneChrome>;`
   then use settled `filesResult.data` to build `docs`.
6. **`file-peek-pane.tsx`** — non-empty sentinel default (legitimate, not
   flagged):
   `const status = filesResult.pending ? "clean" : (filesResult.data.find((f) => f.path === effectivePath)?.status ?? "clean");`

## Follow-up (filed via `add_task`, not in this PR)

Drain the statement-form BURNDOWN: migrate the remaining hook/derivation
collapse sites flagged by the extended rule to gateable results /
`<ResourceView>` / `matchResource`, then empty the allowlist again.

---

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.ts` | add `IfStatement` visitor + `pendingCollapseReturn` message + null-excluding/wrapped-empty helpers |
| `plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.test.ts` | add invalid (statement collapse) + valid (return-null component, non-empty default) fixtures |
| `plugins/primitives/plugins/live-state/lint/index.ts` | reopen BURNDOWN wave (globs for non-reference statement-form hits) + revised comment |
| `…/code/web/use-edited-files.ts` | return `ResourceResult<EditedFile[]>` (drop collapse) |
| `…/push-and-exit/web/components/push-and-exit-button.tsx` | fold `files` into `useCombinedResources`; reorder memo branches below the gate |
| `…/code-review/web/components/code-review-section.tsx` | `ResourceView` wrap |
| `…/code-review/web/components/code-review-summary.tsx` | second pending gate |
| `…/code/plugins/docs-button/web/components/docs-button.tsx` | neutral button while pending |
| `…/code/plugins/docs-button/web/components/docs-pane.tsx` | `<Loading/>` while pending |
| `…/code/plugins/file-pane/web/file-peek-pane.tsx` | non-empty `"clean"` sentinel default |

**Reuse:** `ResourceResult` / `useResource` / `useCombinedResources` /
`ResourceView` (live-state); `useHasActiveSiblings` as the
hook-returns-`ResourceResult` precedent; `FileList`'s existing `null`→`<Loading/>`
path; the existing lint helpers.

## Verification

1. `./equin build` — green `type-check`, `eslint`, `plugins-doc-in-sync`,
   boundaries. The extended rule must not flag any migrated caller.
2. `bun test plugins/primitives/plugins/live-state/lint/no-pending-data-collapse.test.ts`
   — new invalid cases fail, new valid cases pass.
3. Lint guard: a throwaway `if (x.pending) return { files: [] }; return { files: x.data };`
   in a non-allowlisted file → `./equin check eslint` fails (then remove).
   Confirm `if (q.pending) return null; return <div>{q.data}</div>` does **not**.
4. Push & Exit behavior — open a conversation that has edited files and reload;
   the button reads disabled **Exit** during load, then **Push & Exit**, never a
   transient **Drop & Exit**. Use `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/c/<id>`
   to capture before/after; throttle/dev-delay the first WS push to observe the
   race window if needed.
5. code-review section shows `<Loading/>` then files (never a flashed
   "No edited files."); docs button/pane and file-peek render correctly during
   load.
