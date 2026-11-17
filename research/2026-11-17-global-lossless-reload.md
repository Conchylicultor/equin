# A reload never loses what the user was doing

Status: design, for review. Task `task-1794909893-2tmboi` (under `task-1794876540-mrzb6k`).
Siblings: `task-1794909888-iuid0o` keeps old releases served while tabs still use them;
`task-1794909901-nrdryd` reloads old tabs into the new build quietly. That second one only
works if a reload is lossless at any moment. This doc defines that guarantee and the
contract the reload policy reads.

## Context

A deploy should never show a red "reload" pill. The plan is that the tab updates itself at a
safe moment. Today a reload already keeps a lot:

- **Place**: the tab set and per-tab pane routes (`apps-core/tabs` `tabs-store.ts`, session
  area, pane instance ids kept across a reload).
- **Server data**: everything read through `network/live`.
- **Most composer text**: `persistent-draft` `useDraft`, used by Wish, task drafts, the
  conversation prompt, Ask, ask-user-question answers and launch popovers. Pasted images go
  through `draft-attachment-holds`.
- **Scroll**: `PaneScroll`'s `useScrollAcrossReload` / `ScrollRevival`, and
  `useStickyScroll({persist})`.
- **DataView query, expand and active view**: `use-view-ephemeral.ts`, `view-drafts.ts`.

What is lost today (audit, 2026-11-17):

| Gap | Where | What is lost |
|---|---|---|
| Screenshot editor | `screenshot/web/components/screenshot-view.tsx`, `draw-on-app-button.tsx`, `crop-overlay.tsx`, `prompt-form.tsx` | The captured image Blob, strokes, crop, prompt. This is the worst gap: work that cannot be redone. |
| Search / query inputs | `quick-find-dialog.tsx`, `command-palette-dialog.tsx`, `tag-picker-panel.tsx`, `icon-picker.tsx`, `emoji-picker.tsx`, `theme-customizer.tsx` (~24 local `query` states; 82 `useState("")` in 54 files overall) | Half-typed queries. |
| Page-editor sub-forms | `link-form.tsx`, table cell editor, code-block editor, `attachment-upload.tsx` | Text typed into a block's popover form. Block content itself is Y.Doc and safe. |
| Editable fields | `primitives/editable-field/use-editable-field.ts` (18 files) | Text inside the debounce window, and a save that failed. |
| Selections | `primitives/multi-select` (`useMultiSelect`, 7 files) | A multi-row selection being built up. |
| In-flight writes | `network/live/optimistic-mutation` (in-memory overlay and send lane, no outbox) | Ops not yet acked. |
| Live processes | Sonata session, audio engine and recording (`sonata/session/web/session.tsx`, `recording-store.tsx`), chord piano, ambient, keyboard-party, `infra/attachments` `upload.ts` | Playback position, a recording in progress, an upload in flight. |
| Overlay open state | ~80 `[open, setOpen]` files. Dialogs and popovers are never URL- or store-driven. | Which dialog was open. |
| Ad-hoc expand / sub-tab state | ~12 files (`collapsible-wrap.tsx`, `section-pane.tsx`, …) | Collapsed or expanded state. |
| Cross-build drafts | `web-storage` reads an entry written under another schema as `none (other-schema)` | A draft whose schema changed between builds is invisible after an upgrade reload. This loss only appears with automatic upgrades. |

There is one more fact that changes the size of the problem. **Tab residency already
unmounts hidden tabs** (`apps-core/tabs/web/internal/tab-residency.ts`,
`KEPT_HIDDEN_TABS = 2`): "Focusing it mounts it again from that store, as a reload would". So
every gap above is already lost today on an ordinary tab switch, not only on a reload. That
makes it the same problem, with the same fix and the same test.

## The end state

**One invariant: remount ≡ reload ≡ upgrade.** A surface is a function of four inputs:

1. its place (route and pane instance),
2. server data,
3. **kept state** (browser storage, scoped to the place),
4. transient state that may be lost.

Unmounting it, reloading the page, or reloading into a newer build gives back the same
surface, minus transient state only.

From that invariant come three guarantees, each owned by one mechanism:

| Guarantee | Mechanism | Owner |
|---|---|---|
| **Lossless**: nothing the user made is lost | Kept state (work tier), staged blobs, drafts cleared on ack | `primitives/kept-state` (persistent-draft, generalized) |
| **Same place**: the user lands where they were | Place (exists) plus kept state (view tier) | pane / tabs (exist) plus `kept-state` |
| **Unnoticed**: the reload does not interrupt | Reload holds plus an engagement signal, read by the policy | `primitives/dom/reload-readiness` (new) |

### Decision: persist state, hold only for processes

A "dirty registry that blocks reloads" is rejected as the main mechanism. A draft can sit for
days, so a registry keyed on unsaved text would block every upgrade indefinitely. It also does
nothing for the cases we cannot choose the moment of: a crash, F5, or the browser discarding
the tab. Anything that can be serialized is therefore **persisted, so it never blocks**. Only
what cannot be serialized, a **running process**, takes a **hold**: playback, recording, an
upload in flight, a write not yet acked, a drag. A hold ends with the process that holds it,
so it is short-lived by construction.

## State taxonomy

Every piece of client state falls into exactly one class. The class decides where the state
lives and what a reload does with it.

| Class | Examples | Lives in | On reload |
|---|---|---|---|
| **Place** | tabs, pane routes, matrix params | tabs store and history (exist) | restored |
| **Server truth** | everything `useLive` reads | server | refetched or boot snapshot |
| **Work**: made by the user, not yet on the server | composer text, form fields, strokes, crop, chosen attachments, editable-field text before ack | `kept` **work tier**: local area, `refuse` when full, long TTL, scoped by subject (conversation, task, page block) | restored, **across builds** |
| **View**: where the user was looking | scroll, expand/collapse, sub-tab, search query, multi-select, open work overlay | `kept` **view tier**: session area, one pooled store, `evict-oldest`, scoped by pane instance | restored, best effort (dropped if its schema changed) |
| **Transient** | hover, focus ring, menus, tooltips, busy flags, animations | React state | lost by design. The moment policy avoids reloading mid-use. |
| **Process** | audio playback, recording, upload, optimistic send lane, drag | memory, plus a **reload hold** | the quiet reload waits for it. A forced one tells the user what stops. |

Blobs (screenshots, recordings, files) are **never** kept in browser storage, which caps out
at about 10 MB per origin. They are uploaded as soon as they exist, as **staged attachments**
(`infra/attachments` already creates an ownerless staged row, and `draft-attachment-holds`
keeps them alive across reloads). Work state holds the attachment id.

## The primitives

### 1. `kept-state`: generalize `persistent-draft`

Rename `primitives/persistent-draft` to `primitives/kept-state` with `./equin plugin move`.
`useDraft` stays as the work-tier spelling.

```ts
// module scope: a literal owner, cap and schema (the web-storage budget check reads them)
export const linkDraft = defineKept({
  owner: "page.link-form", tier: "work", cap: "64 KB",
  schema: z.object({ url: z.string(), text: z.string() }),
  migrate: { /* <prior schema stamp>: (old) => next */ },   // work tier: see "Across builds"
});
export const pickerQuery = defineKept({ owner: "icon-picker.query", tier: "view", schema: z.string() });

// in a component
const [draft, setDraft, clear] = useKept(linkDraft, { url: "", text: "" }, { subject: blockId });
const [query, setQuery] = useKept(pickerQuery, "");        // scope = the ambient KeepScope
```

- **Work tier**: one `defineStore` per owner (area `local`, `whenFull: "refuse"`,
  `DEFAULT_DRAFT_TTL`). `subject` is required (a type error without it), because work belongs
  to what it is about (a conversation, a task, a block), not to the pane that happens to show
  it. Two panes on one conversation share its draft, as `useDraft` already does.
- **View tier**: no store of its own. All view state shares **one pooled session store**
  (`kept.view`, `evict-oldest`, one cap), with id `<KeepScope>/<owner>`. A dozen owners
  therefore never each need a budget line. The scope is the ambient **`KeepScope`**:
  - The pane primitive provides the pane instance id (already kept across reload,
    `keepInstanceIds`).
  - `tab-surface` provides the tab id for state outside a pane.
  - `PluginScope` nesting composes as web-storage already does.

  When a pane instance leaves the pane store (it is closed, not just unmounted), its view
  state is removed (`removeEntriesWhere` over the pool, the same lifetime pattern
  app-instance uses). The TTL is only a backstop.
- **Write cost**: a write updates React state and schedules the storage write at the end of
  the frame. `flushKept()` writes synchronously. `pagehide` and the quiet reload call it, so a
  keystroke is never lost to batching. The render-free `readDraft` / `writeDraft` stay for
  input-frequency writers (scroll, caret).
- **Clear on ack, not on submit**: `submitKept(handle, send)` clears the work only once
  `send` resolves. A reload between the submit click and the server ack then keeps the draft,
  instead of losing both. This becomes the only exported way to clear work after a send.
  `clear()` is kept for an explicit discard.

### 2. `reload-readiness`: holds, engagement, `quietReload`

New plugin `primitives/dom/plugins/reload-readiness` (web). This is the whole contract the
reload policy (`nrdryd`) reads:

```ts
useReloadHold(active: boolean, { label: "Recording" | … })   // a process holds the tab
holdReload(label): () => void                                  // imperative twin (engines, lanes)
useReloadReadiness(): {
  holds: readonly { label: string }[];
  engaged: boolean;          // popup open (popup-open's anyPopupOpen) || focus in an editable
                             // || input in the last 10 s || pointer down
  hidden: boolean;           // document.visibilityState
}
quietReload(): Promise<never>   // flushKept() → wait until holds = [] → location.reload()
```

- **Holds come from the primitives, not from call sites**, so a feature cannot forget one
  (rung 1):
  - The audio engine (`sonata/audio/engine`, `music/ambient`, chord piano) holds while
    playing or recording.
  - `infra/attachments` `upload()` holds per request.
  - The optimistic send lane holds while it has unacked ops (they ack in milliseconds, so a
    drain wait replaces an outbox).
  - The drag primitive holds mid-drag.
- **Engagement reuses `popup-open`**, which already knows whether any popup is open. The
  overlay primitives must publish through it (see Enforcement). Open overlay state is
  therefore **not** persisted generically: the policy does not reload while one is open, and
  a work overlay's content is kept. The overlays that are work surfaces (Wish, task-draft
  popover, screenshot editor) also keep their open flag as view state, so a forced reload
  reopens them.

### The policy, as `nrdryd` should implement it

```
stale (useStaleFrontend) ─┬─ hidden && holds=[]                 → quietReload()      (the common case)
                          ├─ visible, !engaged, idle ≥ 30 s, holds=[] → quietReload()  (plus a quiet "Updated" toast)
                          └─ forced (outdated skew / broken plugin)
                               ├─ holds=[] → quietReload() at once (still lossless)
                               └─ holds    → neutral pill "Update waits for: Recording", reload when released
```

The menu-bar panel's own hidden-reload (`companions/menu-bar/web/internal/stale-reload.tsx`)
becomes the first branch of this one policy and is deleted. The red pill survives only for
`broken` with the served build itself missing files, which is a real fault and not an
upgrade.

## Across builds

An upgrade reload reads work written by the previous build. Web-storage deliberately leaves
an entry from another schema unread (`other-schema`), and for work that is a loss. The fix:

- **Work tier**: `defineKept` takes `migrate`, keyed by prior schema stamp. A new check,
  `kept-state:work-schema-migrates`, compares each work owner's `describeSchema` stamp with
  `main`'s. A changed stamp without a `migrate` entry for main's stamp fails (rung 3). The
  usual change, an added optional field, migrates as identity.
- **View tier**: dropping is acceptable. No migration is required.
- A **downgrade** (an old tab reading a newer entry) still leaves it in place, as today. The
  old tab is about to upgrade anyway.

## Enforcement (fix ladder)

| Rung | What |
|---|---|
| 1. Inexpressible | Holds live inside the audio engine, the upload primitive, the send lane and drag, so no feature spells a process without one. `useMultiSelect` keeps its selection as view state by construction. Work is cleared only through `submitKept`. Blobs reach a surface only as staged attachment ids: `screenshot` gets the id from the capture, not the Blob. |
| 2. Type | The text-input primitives (ui-kit `Input`, `Textarea`, `text-editor` composer, `editable-field`) take a required `keep` prop: a `useKept` binding, or `transient("<reason>")` (a search filter that is truly throwaway, a password). The value/onChange pair becomes internal. A forgotten draft is now a type error instead of a missing feature. `useKept` work tier requires `subject`. |
| 3. Lint / check | `ui-state/no-raw-text-input` bans `<input type=text\|search>` / `<textarea>` / `contentEditable` outside the input primitives (~58 files today, migrated, then the rule is `error`). `ui-state/no-blob-in-state` is a type-aware ban on `useState` / `useRef` holding `Blob \| File \| MediaStream`. `overlay/publishes-popup` requires every dialog/popover/menu to go through the overlay primitives, which publish to `popup-open`, so raw Radix roots are banned outside them. Plus the `kept-state:work-schema-migrates` check. |
| 4. Runtime | **Reload drill** in the e2e harness: `reloadDrill(page, step)` runs a step, records every input's value, `[data-kept]` markers, scroll offsets and the route, then reloads and also remounts through tab residency, and diffs. The domain flows of Wish, the composer, the screenshot editor, the page editor and Sonata get one. In dev builds, a debug action **Remount every tab** lets a person try it by hand. |
| 5. Doc | `kept-state/CLAUDE.md`: the taxonomy table above, and how to classify a new piece of state. |

Plain `useState` stays legal: most of it is transient (busy flags, hover). The rules target
the shapes that carry work (text inputs, blobs, processes) rather than trying to classify
1,775 `useState` calls.

## Coverage: how we know every surface is handled

Coverage cannot be proven statically: 1,775 `useState` calls cannot be classified by
reading them. Four nets instead, each catching what the one before misses, so a forgotten
surface is found by a net and not by an audit.

1. **Close the shapes that carry work, by construction**:
   - typing: the required `keep` prop, plus `no-raw-text-input`
   - files: `no-blob-in-state`, plus staging on capture
   - selection: `useMultiSelect` keeps it itself
   - processes: holds inside the engines, uploads, the send lane and drag
   - writes: `submitKept`

   What is left over is work held in ordinary component state (drag-built structures, a
   canvas, a wizard step).
2. **Dev unmount detector**, which covers every `useState`. In dev builds, when a tab or pane
   unmounts, walk the React fiber's hook list. Flag each `useState` / `useReducer` whose value
   differs from its initial one, that is not a `useKept` (tagged) and not marked
   `transient("why")` at its declaration. Each one is state being thrown away, reported with
   the component and file as a `reload-loss` report.

   An unchanged value is never flagged, so busy, open and loading flags that are back at their
   default when you leave filter themselves out. Tab residency unmounts hidden tabs during
   ordinary use, so dogfooding exercises this net constantly. The reports are the audit: the
   set of unclassified state is finite and only shrinks, and new code is covered the day it is
   written.
3. **Remount crawler**: a generic `reloadDrill` that runs nightly on main over every route and
   every exhibit. It types into every input, toggles switches, expands sections and selects
   rows, then remounts and reloads, and diffs input values, `aria-expanded` / `aria-selected`,
   scroll offsets and `[data-kept]` markers. It files a report per differing surface. It
   catches state that lives only in the DOM, which the detector cannot see, and it is the
   checklist for migrating the existing surfaces (it replaces the hand audit table).
4. **Production fingerprint**: `quietReload()` records what the user can see (input values,
   open work overlays, selection counts, the set of drafts) before it reloads. Once the new
   page has booted and settled, it compares. A difference is a `reload-loss` report naming the
   surface. This measures the real guarantee on real reloads, not our model of it.

The remaining gap is state that never shows in the DOM and changed only during a short-lived
component's life. Nets 2 and 4 narrow it but do not close it.

## Migration (phased, each phase one task)

1. **kept-state**: rename persistent-draft, add `defineKept` / `useKept` (both tiers),
   `KeepScope` from pane and tab-surface, the view pool and its pane-close GC, `flushKept` on
   `pagehide`, `submitKept`. Move the existing `useDraft` callers to `submitKept` where they
   clear after a send (Wish, task-draft, prompt-input, ask).
2. **reload-readiness**: holds, engagement, `quietReload`. Holds wired into the audio
   engine(s), `attachments` upload, the optimistic send lane and drag. This unblocks `nrdryd`.
3. **Text inputs**: required `keep` prop on the input primitives, then migrate the ~58
   raw-input files and ~24 search states, then make `no-raw-text-input` an error. Includes
   quick-find, command palette, pickers, the theme customizer and the page-editor sub-forms
   (link, table cell, code block). `editable-field` keeps its pending text as work until ack.
4. **Gaps**:
   - Screenshot editor: upload as a staged attachment on capture, keep strokes, crop and
     prompt as work.
   - `useMultiSelect`: view tier.
   - Ad-hoc collapsibles: `collapsible-wrap` keeps state as view tier.
   - Work overlays keep their open flag.
   - Sonata: the session's play position, tempo and loop become view state, so a forced
     reload resumes paused at the same bar.
5. **Across builds**: `migrate` plus the `work-schema-migrates` check.
6. **Coverage nets**: the `reloadDrill` harness helper and the five domain flows, the
   generic remount crawler (nightly), the dev unmount detector with `transient("why")`
   marking on `useState`, and the `quietReload` fingerprint comparison, all filing
   `reload-loss` reports.
7. **Policy** (`nrdryd`, already filed): consumes `useReloadReadiness` / `quietReload` and
   deletes the menu-bar stale-reload.

## Non-goals and open questions

- **Cross-device drafts** (work on the server instead of browser storage). This is the same
  API with a server backend behind the work tier, and would be a later change. Local storage
  is enough for "this tab reloads".
- **Caret and text selection** inside an editor. The page editor (Y.Doc) and composer could
  keep them as view state, but this is not required for "loses nothing the user cares about".
  Revisit after phase 3.
- **Mid-gesture state** (a drag half done) is a hold, not kept state.
- **Live processes cannot resume exactly.** A forced reload during playback resumes paused at
  the same place, never playing. Sound starting by itself after a reload would be worse than
  silence.

## Verification

- Unit: `useKept` round trip through a remount (scope keys, pane-close GC, clear on ack);
  `quietReload` waits for holds and flushes; the `work-schema-migrates` check against a
  fixture schema change.
- `./equin test plugins/primitives/plugins/kept-state plugins/primitives/plugins/dom/plugins/reload-readiness`
- E2E: `reloadDrill` flows on a build (type in Wish, a link form, a quick-find query; draw on
  a screenshot; select rows; reload, then compare). Tab-switch remount through tab residency
  in the same flow.
- End to end with `nrdryd`: build twice with a visible change while a tab has open drafts and
  a half-drawn screenshot. The tab updates while hidden, and everything is there when you
  come back.
