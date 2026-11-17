# kept-state

What a reload, a tab switch (tab residency unmounts hidden tabs) or an
upgrade into a new build must give back. One invariant: **remount ≡ reload ≡
upgrade** — a surface is a function of its place (route, pane instance),
server data, **kept state** and transient state that may be lost. Design:
[`research/2026-11-17-global-lossless-reload.md`](../../../../research/2026-11-17-global-lossless-reload.md).

## Classify a piece of state

| Class | Examples | Lives in |
|---|---|---|
| Place | tabs, pane routes, matrix params | tabs store, history (not here) |
| Server truth | everything `useLive` reads | the server |
| **Work** — made by the user, not on the server yet | composer text, form fields, chosen options | `defineKept({ tier: "work" })`: a local store of its own, `refuse` when full, 7-day TTL, one entry per **subject** |
| **View** — where the user was looking | expanded, sub-tab, search query, selection | `defineKept({ tier: "view" })`: the one pooled session store, keyed by the ambient **KeepScope**, dropped when that place closes |
| Transient | hover, focus ring, menus, busy flags | React state — lost by design |
| Process | playback, recording, an upload, a drag | memory, plus a reload hold (reload-readiness, P2) |

Blobs never go in browser storage (≈10 MB per origin): upload them as staged
attachments and keep the attachment id as work.

## Declare and read

```ts
// module scope; owner, cap, tier and stamp literal (the budget-fits and work-schema-migrates checks read them)
export const linkDraft = defineKept({
  owner: "page.link-form", label: "Link drafts", tier: "work", cap: "64 KB",
  schema: z.object({ url: z.string(), text: z.string() }),
  stamp: "1x2y3z", // the check names the value
});
export const pickerQuery = defineKept({ owner: "icon-picker.query", tier: "view", schema: z.string() });

const [draft, setDraft, clear, kept] = useKept(linkDraft, { url: "", text: "" }, { subject: blockId });
const [query, setQuery] = useKept(pickerQuery, "");
```

- **Work** requires `subject` (a type error without it): work belongs to what
  it is about, not to the pane showing it — two panes on one conversation
  share its draft.
- **View** has no store of its own: every owner shares `kept.view` (session,
  `evict-oldest`, one budget line), under the id `kept/<scope path>|<owner>`.
  An entry its owner's schema no longer reads is not restored (best effort).
  Several instances of one owner in the same place (two lists, each with its
  own selection) pass `{ key }` — stable across a reload, unique among the
  owner's instances there — and get one entry each (`…|<owner>#<key>`);
  `{ key: null }` holds that instance in memory only. Primitives that hold
  view state take the key from their caller — required where every caller has
  one (`MultiSelectProvider`'s and `useExpandAll`'s `keep`), optional where
  not (`useCollapsible` / `<Collapsible keep>`).
  Outside every `KeepScope` (an exhibit, a test) view state is memory only.
- `useDraft(store, initial, { scope })` is the same hook over a store the
  caller declared with `defineStore` — the existing spelling, kept.

## Text inputs: the required `keep`

Every text field decides whether what is typed in it survives a reload and a
tab switch. The text-input primitives — ui-kit `Input` / `Textarea`,
`TextEditor` / `ComposerField` / `PromptEditor`, `SearchInput`, and
`useEditableField` — take a **required** `keep` (`TextKeep`, from `core/`):

| `keep` | Means | The field's `value` / `onChange` |
|---|---|---|
| a `useKept` / `useDraft` binding | kept (work or view) | the binding's; no `value` prop (type error), `onChange` runs after it |
| `keptField(binding, "text")` — one string field of a kept object | kept: typing writes into the object entry | the object's field |
| `keptField(keptItem(cards, (c) => c.id === id), "text")` — a string part handed down by a host (`cards: KeptPart<Card[]>`, from `keptPart(binding)` / `keptField(binding, "cards")`) | kept: typing writes into the one entry the part was projected from | the part's |
| `field.keep` of a `useEditableField` | kept by the field: pending text is work until the save is acked | the field's |
| `transient("<why>")` | throwaway by design — a secret, a value committed on every change | the caller's own |

```tsx
const name = useKept(renameDraft, "", { subject: pageId });
<Input keep={name} />
<Input type="password" keep={transient("secret: never written to browser storage")} value={pw} onChange={…} />
const title = useEditableField({ value, onSave, keep: { field: "task.title", subject: taskId } });
<Input keep={title.keep} onFocus={title.onFocus} onBlur={title.onBlur} />
```

A host hands a leaf its piece of a kept value as a `KeptPart<T>` — never as
a `value` / `onChange` pair. Parts are minted only by projecting a binding
(`keptPart`, `keptField`, `keptItem`, composable), so plain `useState` has no
spelling as kept text: there is no `keptText(value, setValue)`. The one part
not projected from a binding is `useEditableField`'s `keep`, which keeps its
pending text in its own work store.

`Input` / `Textarea` take `bare` for a field the host styles itself (an inline
title, a cell): no chrome, no density size — the keep decision stays. The
`kept-state/no-raw-text-input` lint rule bans the raw spellings (`<textarea>`,
a text `<input>`, `contentEditable` on a DOM element) everywhere else; a
surface whose content is persisted another way (the page editor's Y.Doc)
declares a sanctioned exemption.

`useEditableField`'s kept text lives in one work store
(`editable-field.pending`, `{ text, base }` per `<field>|<subject>`): a remount
restores the unsaved text and resumes its save, or shows it as a conflict when
the source moved on since `base`. It is cleared once a save of it resolves,
when the field adopts or converges with the source, and on `acceptExternal`.
A failed save keeps it.

## The KeepScope

`<KeepScope segment>` nests: tab-surface opens `t:<tabId>` around a tab's
app, the pane primitive's `<PaneInstance>` (what a layout renderer wraps each
instance in) opens `p:<uuid>`. Both ids survive a reload (the tabs store keeps
tab ids and slot uuids), so the path does too. `forgetKeepScope(segment)`
drops the view state of a place gone for good and of every place nested in
it: the pane store calls it for each instance a close removes, the tabs
store for a closed tab. An unmount is not a close — a hidden tab comes back.
The pool's TTL is the backstop for places that end without a close (a pane
replaced in place).

## Writes: batched, flushed on pagehide

A setter updates React state and schedules the storage write at the end of
the frame (`requestAnimationFrame`; at once in a hidden page). `flushKept()`
writes every pending one synchronously; it runs on `pagehide` and when the
page hides, and the quiet reload (P2) calls it. `readDraft` answers from the
pending writes first. `readDraft` / `writeDraft` stay the render-free,
immediate twin for callers writing at input frequency (a scroll offset, a
caret).

## Clear on ack: `submitKept`

```ts
const result = await submitKept(kept, (text) => sendIt(text));          // stays shown until ok
void submitKept(kept, (text) => send(id, { text }).posted, { shows: "at-once" }); // composer
```

`send` resolves `{ ok }`. The entry is cleared only once it resolves `ok`,
and only while storage still holds what was sent (text typed since is never
cleared) — so a reload between the click and the server's answer keeps the
work instead of losing it with the request. A rejected or `ok: false` send
leaves it. `"at-once"` empties the field immediately (the field stays typable)
while storage keeps the text until the ack. This is the one way to clear work
after a send; the binding's `clear()` is for an explicit discard.

## Across builds: `stamp` and `migrate`

An upgrade reload reads work the previous build wrote. web-storage stamps
every entry with the schema that wrote it (`schemaStamp`, web-storage core)
and leaves an entry from another schema unread (`other-schema`) — for work,
that would hide the user's draft on every upgrade that changed the schema. So
a work owner carries:

- `stamp` — its schema's stamp, as a literal. The
  `kept-state:work-schema-migrates` check imports each declaring module,
  computes the real stamp and names it when the literal is wrong; the literal
  is what lets the check read **main's** stamp from main's source without
  evaluating main.
- `migrate` — keyed by a prior stamp: how what that schema wrote is read now
  (the result is parsed with `schema`). The check fails when the stamp differs
  from main's and `migrate` has no entry for main's. An added optional field
  migrates as the identity:

```ts
schema: z.object({ text: z.string(), mode: z.enum(["a", "b"]).optional() }),
stamp: "<new stamp>",
migrate: { "<main's stamp>": (old) => old },
```

A migrated entry is not rewritten on read (a tab still on the old build reads
it too); the next write stores it under the new stamp. When the schema changes
again, the check asks only for the newest prior stamp: update or drop the
older entries (a draft they still describe is then left unread, as before).
A downgrade (an old tab reading a newer entry) still leaves it in place — the
old tab is about to upgrade. **View** state needs neither: an entry its
schema no longer reads is dropped, which is acceptable for where the user
was looking.

`useDraft` over a store declared with `defineStore` can pass the same
`migrate` to `defineStore`; the check covers `defineKept` work owners only.

## Loud refusal, legacy keys

A refused write is never silent: the store announces it (a toast once per
owner, a report, the health report's Browser storage row) and the value stays
in memory. `legacyDraftKeys(<old key>)` is the `legacy` of a store taking over
drafts written before web-storage (`<prefix>:draft:<key>[:<scope>]`); it
carries them over, so no unsent text is lost — drop it once browsers migrated.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Kept state: what a reload, a tab switch or an upgrade must give back. defineKept declares a piece of it in one of two tiers — work (what the user made and the server does not have yet: its own local store, refused when full, one entry per subject) or view (where the user was looking: one pooled session store, keyed by the ambient KeepScope — the pane instance, else the tab — and dropped when that place closes, forgetKeepScope) — and useKept reads it as a useState drop-in. useDraft is the same over a store the caller declared (defineStore). Writes are batched to the end of the frame and flushed on pagehide (flushKept). submitKept clears work only once its send is taken, so a reload between the click and the ack keeps it. readDraft/writeDraft are the render-free twin for callers writing at input frequency; onDraftWritten(scope, listener) observes every write and clear in one composition scope; legacyDraftKeys carries drafts written before web-storage into a store. core/ holds the required `keep` prop of every text-input primitive (TextKeep: a kept binding, a part projected from one — keptPart / keptField / keptItem, so plain state has no spelling as kept — or transient("<why>")), and lint/ bans raw text fields (kept-state/no-raw-text-input).
- Web:
  - Uses:
    - `primitives/dom/web-storage.defineStore`
    - `primitives/dom/web-storage.LegacyKeys`
    - `primitives/dom/web-storage.removeEntriesWhere`
    - `primitives/dom/web-storage.ScopedStore`
    - `primitives/dom/web-storage.Store`
    - `primitives/dom/web-storage.StoreSpec`
    - `primitives/dom/web-storage.useStore`
    - `primitives/latest-ref.useLatestRef`
  - Exports (types):
    - `DraftOptions`
    - `DraftWrite`
    - `KeptView`
    - `KeptViewSpec`
    - `KeptWork`
    - `KeptWorkSpec`
    - `SubmitShows`
  - Exports (values):
    - `clearDraft`
    - `DEFAULT_DRAFT_TTL`
    - `defineKept`
    - `flushKept`
    - `forgetKeepScope`
    - `KeepScope`
    - `legacyDraftKeys`
    - `onDraftWritten`
    - `readDraft`
    - `submitKept`
    - `useDraft`
    - `useKeepScope`
    - `useKept`
    - `writeDraft`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --input`
  - Imported by: 126 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×37
    - `primitives` ×25
    - `conversations` ×12
    - `fields` ×11
    - `page` ×9
    - `ui` ×5
    - `auth` ×4
    - `tasks` ×4
    - `debug` ×3
    - `apps-core` ×2
    - `infra` ×2
    - `screenshot` ×2
    - `active-data/task`
    - `build`
    - `hints/ask`
    - `integrations/google-maps`
    - `map`
    - `reorder/editor`
    - `search/quick-find`
    - `shell/global-action-bar`
    - `tag-tree/picker`
    - `wish`
- Exemptions:
  - Exempted by:
    - `page/editor` (0 debt)
    - `primitives/css/ui-kit` (0 debt)
- Core:
  - Exports (types):
    - `KeptBinding`
    - `KeptHandle`
    - `KeptPart`
    - `KeptSetter`
    - `KeptSource`
    - `KeptText`
    - `KeptWorkDeclaration`
    - `TextKeep`
    - `Transient`
  - Exports (values):
    - `isTransient`
    - `keptField`
    - `keptItem`
    - `keptPart`
    - `keptWorkDeclarations`
    - `recordKeptWork`
    - `resolveTextKeep`
    - `transient`

<!-- AUTOGENERATED:END -->
