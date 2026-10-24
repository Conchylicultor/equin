# Media blocks and the editor's caret

## Context

Nine block renderers in the page editor register no focus handle at all: `image`,
`video`, `audio`, `file`, `embed`, `bookmark`, `place`, `page-link`, and the
`unknown` fallback (`editor/web/components/unknown-block.tsx`).

`editor.navigate()` walks the registered handles — and says so in a comment
(`block-editor-context.tsx`, "Skip void blocks with no registered focus handle
(e.g. images)") — so arrow keys jump from the paragraph above an image straight
to the paragraph below it. A click still focuses *parts* of these blocks
(`AttachmentUpload` carries its own `role="button" tabIndex={0}`), so the browser
and the editor's focus model disagree about where the user is. None of them
paints a "the caret is on this block" cue, so even when the editor's model does
point at one, nothing on screen says so.

The plumbing for all of this already exists in
`editor/web/components/void-caret.tsx`, which `divider`, `sub-page`, `code-block`
and `math/equation` go through. The nine simply never opted in.

**That "opting in" is the real defect.** Eight block types forgot the same four
lines, and nothing anywhere could tell them they had. A tenth media block type
would forget it too. So this change is not "call the hook nine more times" — it
is to remove the thing there is to forget, and to decide what a caret ON a media
block actually MEANS, which nobody had ever stated.

## The meaning

> A media block is **one object in the document**. The caret on it means *this
> object is the current line*. It never means *you are inside it*.

Everything below is a consequence of that one sentence, and it is the same
sentence for all nine — the differences between an image and a bookmark are
differences of payload, not of what the caret is doing there.

- **Focus lands on the block's own box**, in every render state — empty,
  uploading, resolving, filled, error. Never on an inner control.
- **The controls inside stay reachable** — the upload dropzone, the URL and
  search inputs, replace/remove buttons, the file card's `<a>`, native `<video>`
  controls. They report focus *upward* (React `onFocus` is `focusin`, which
  bubbles), so DOM focus and the editor's model can no longer come apart: any
  focus anywhere inside the block makes that block the current one.
- **Backspace/Delete removes the block**, one press, whatever the payload holds.
  A filled image is one object, not "content to clear and then a block to
  delete". The attachment itself is not orphaned by this: the block↔attachment
  link (`page_blocks_attachments`) survives the soft delete, editor undo
  re-inserts the row under its **original id**, and only the existing orphan TTL
  sweep ever reclaims bytes.
- **Enter means "keep going"**, and what that is depends on whether the block is
  filled:
  - *unfilled* — the block is a **prompt** asking for a payload, so Enter fills
    it: open the file picker, focus the URL box, open the page picker.
  - *filled* — the block is an **object**, so Enter starts a paragraph below it.
- **↑/↓ always leave.** Already the editor's invariant; see below for the half of
  it that was still hand-copied.

This is Notion's model, and it is the one users arrive with.

### What is deliberately NOT here

`sub-page` keeps refusing Backspace — deleting a sub-page destroys a whole
content partition, so it stays an explicit menu action. That refusal is why it
declares its own caret rather than taking the editor's.

**Captions are out of scope**, and the reason is structural rather than
budgetary. No media block has one today. A caption is text, and the honest place
for text in this editor is a *text-bearing block* — a child text row under the
media block — so that it gets the real Lexical caret, marks, links, collab and
undo. Adding a `caption` string to a void block's schema would flip
`handle.acceptsText` (which is derived from `"text" in schema.shape`) and make
the type half text-bearing, which the `BlockRegistration` union, the split/merge
reducer and the markdown pipeline all read. Filed as a follow-up.

## The structural fix

### 1. The editor mounts the caret host — the block does not

`BlockRow` has exactly one `<Editor.Block.Dispatch>` call site. It wraps that
call in `BlockCaretHost` for every text-less block type that has not declared it
owns its own caret. A media renderer then writes **no caret code at all**.
`BlockCaretHost` is deliberately NOT exported from the web barrel: a block that
could mount one for itself could equally forget to, which is the whole class of
bug being closed.

The wrapper adds no padding of its own. It sits at the row's content-left edge
`C` (the row already applies `paddingLeft: contentLeft`), which is exactly where
the page-column invariant says a *decoration* lives — and the caret cue is a
decoration. Every media block keeps its own `<Inset x={BLOCK_INSET}>`, unchanged.

Its accessible name comes from `handle.label` ("Image", "Bookmark", "Link to
page", …), which all nine already declare, so there is nothing new to author.

### 2. Answering "where does my caret live" becomes a tsc error

`BlockRegistration` (`editor/web/slots.ts`) is already a discriminated union
whose text-less arm requires `component`. A required sibling joins it:

```ts
caret: "editor" | "renderer";
```

- `"editor"` — the editor mounts the host. The renderer does nothing.
- `"renderer"` — the renderer registers its own handle through `useVoidCaret`,
  because it owns the thing that must hold the caret: a `<textarea>` (code,
  equation) or a `Row`'s synthesized control (sub-page).

Registering a text-less block type without answering is now a **compile error**.
That is the highest rung available here: the editor genuinely cannot decide for a
code block, so the fact has to be declared — but there is no longer any way to
*not* declare it, and no "absent" state that silently means "unreachable".

`BlockRow` reads the field off the contribution it already looks up. **Anything
with no registration at all** — the `unknown` fallback — falls into the
editor-hosted arm: the fail-safe direction, and the one the type system cannot
reach.

A **container anchor** gets a third arm on which `caret` is `never`, because it
renders no line at all. There was a version of this with a `"children"` value and
a check pinning it to `anchor: true`, and the check was the tell: it existed only
because the design had chosen to state one fact twice, in exactly the way this
plugin's container doctrine warns against. The rung-2 form turned out to be two
lines — `defineContainerBlock` now states `anchor: true` in its RETURN type, so
"this went through the container factory" is provable rather than merely
conventional, and the arm keys on that. No new value, no check.

### 3. The keys, once, on the host

| key | meaning | origin |
| --- | --- | --- |
| ↑ / ↓ | leave the block | anywhere inside |
| Escape | enter block-selection mode | anywhere inside |
| Backspace / Delete | `navigate("up")` then `remove()` | the host itself |
| Enter | the block's **activation** if it has one, else a paragraph below | the host itself |
| Space | the activation, or nothing | the host itself |

The origin split is not uniform, and that matters. A single origin guard would
mean that once focus is on any inner control — the upload dropzone, a URL field,
a link — ↑/↓ reach nothing and the user cannot leave the block by keyboard at
all: the exact stranding this module exists to prevent, reintroduced. So the
escapes run wherever they originated, subject only to `defaultPrevented`, which
is the protocol an inner control uses to claim the arrows (the place block's
result list already does exactly that while its suggestions are open).

Escape is new and load-bearing: a text block reaches block-selection mode through
Lexical's own listener, and with Backspace now deleting rather than selecting,
this is the only keyboard route into a selection containing a media block.

The paragraph is minted generically from the registry via `defaultTextHandle`
(precedent: `use-insert-block-below.ts`), so the editor still never names the
text block type and `divider` / `equation` can delete their hand-rolled
`textBlock.schema.parse({ text: [] })` seeds.

**Activation is registered from inside, not passed as a prop** — the host is
mounted by the editor *around* the block, so there is no prop channel. A small
context hook (`useBlockActivate(fn)`) is how a render state says "Enter here
means this". One call inside the shared `AttachmentUpload` covers image, video,
audio and file at once; `embed` / `bookmark` / `place` focus their input;
`page-link` opens its picker or the page. A filled media block registers none,
so Enter falls through to "paragraph below".

### 4. Two focus guards, for two different failures

Wrapping *interactive* content makes two questions askable that a divider never
had to answer. Both are new rules, and neither is the identity guard
(`activeElement !== ref.current`) that `void-caret.tsx` correctly dismisses as
buying nothing — that one compared a node with itself.

**Focus is already inside me.** Clicking "Remove image" focuses the button, which
bubbles, which makes this the current block, which flips `isFocused`, which runs
the pull — stealing focus off the button the user just clicked. So the capability
declines when `contains(document.activeElement)`. This is a **containment**
question, and it **cannot see through a portal**: a popover rendered to
`document.body` is not a descendant. That is why `page-link`'s picker opens from
its activation instead of auto-opening on mount — an auto-open would race this
and lose, leaving the picker's search box dead to the keyboard.

**Focus went nowhere.** The block's own control can unmount under the user's
feet: "Remove image" clears the payload, so the focused button disappears and
focus falls to `<body>`. `isFocused` never changed, so the first rule's effect
never re-runs, and the model says the caret is here while the keyboard is
nowhere — arrows dead until the user clicks again. So focus is reclaimed on every
commit, but **only from `null` / `<body>`**. Not "anywhere outside this row":
that would steal from a portal, i.e. the first rule's blind spot arriving by a
different road.

### 5. Blocks stop knowing about focus

`AttachmentUpload`'s `onArm` prop, `place-search.tsx`'s `onFocus` prop and
`embed`/`bookmark`'s `onArm` wiring all existed to hand-report focus to the
editor. Focus now bubbles to the host, so all of them are deleted — including the
comment in `place-search.tsx` that documents the missing `registerFocusHandle` as
if it were a design choice.

### 6. The arrow-escape invariant belongs to the editor in BOTH arms

`useVoidCaret` also hands back the ↑/↓ escape handler. Today "a caret can always
leave a void block" is enforced only for the box arm, while `sub-page`
hand-copies it — which is exactly the shape of the bug this whole change is
about. Textarea blocks (code, equation) deliberately do not take it: their arrows
move within their own source.

### 7. Two prerequisites in `page-link`

`if (result.pending) return null;` renders a not-known-yet state as *nothing* —
both a violation of the repo's "not-known-yet is a state to render" rule and, now,
a zero-height focusable box, which `rowAtPointer`'s `r.height > 0` guard then
skips on the containment pass. It becomes a loading row.

Its picker also drops `autoOpen`, for the portal reason in §4; Enter opens it
instead. That costs one keystroke on insertion and buys a picker that cannot be
raced.

`page-link` takes `"editor"` rather than mirroring `sub-page`'s `"renderer"`
because it has four render states (picker, pending, not-found, resolved) and only
one of them has a `Row` control worth holding the caret. `sub-page` has one.

### 8. The margin stays row background

The host is full-width, so a press on the empty strip beside a 480px image lands
on it rather than on the row — which would silently stop the whole margin of
every media row from being background: no marquee could start there. The host
carries `data-caret-host` and the editor's `onPointerDown` treats a press on the
host *itself* as a press on the row. A press on real content still hits a
descendant and is still content.

One behaviour does change and is worth stating: a margin click used to *select* a
media block (it fell through to `applyRange` for a row with no focus handle) and
now *focuses* it, ignoring the click's edge — a void block is one position, with
no start or end to distinguish. Selecting it is one Escape away.

## Files

- `editor/web/components/void-caret.tsx` — containment-guarded focus, the
  Backspace/Enter meanings, `defaultTextHandle` paragraph seeding, the activation
  context, the hook's arrow handler.
- `editor/web/slots.ts` — the `caret` field on `BlockRegistration`; the derived
  type-set hook.
- `editor/web/components/block-row.tsx` — mount the host around the one dispatch.
- `container/core/define-container-block.ts` — `anchor: true` in the return type,
  which is what gives a container its own registration arm.
- The nine renderers + `attachment-block/web/components/attachment-upload.tsx` —
  declare `caret`, register activations, delete the focus plumbing.
- Every other text-less registration (`divider`, `sub-page`, `code-block`,
  `math/equation`, and the container types) — declare `caret`.
- `editor/e2e/media-caret-verify.ts` — new. Phase 1 enumerates the insertable
  types **at runtime** off a new `data-block-type` hook and asserts every one of
  them leaves the keyboard somewhere, so a tenth media type is covered without
  editing the script; an editor-owned spec that imported nine contributor core
  barrels would be the collection-consumer inversion, and would pass while
  missing the type nobody remembered.

## Verification

- `./equin check` (`type-check` is the real gate — the required `caret`
  field means every text-less registration must have been updated).
- `./equin build`, then
  `bun plugins/page/plugins/editor/e2e/media-caret-verify.ts`: arrow down through
  an image lands ON it (not past it); the cue paints; Backspace deletes it and
  leaves the caret above; Enter on a filled image opens a paragraph below; Enter
  on an empty one opens the picker; typing in the embed URL box is not eaten.
- `bun plugins/page/plugins/divider/e2e/divider-caret-verify.ts` must still pass
  — the divider moves from writing its own box to being handed one.
