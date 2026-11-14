# Pages app: UX gaps versus Notion (desktop and phone)

Task: att-1794626300-xy8aj8. Investigation only, no code changed.

## Method and limits

- Drove my own build (`./equin build`) through the `browser_*` MCP tools at 1280×800 and 390×844.
- On the build I created a page and tried the slash menu, markdown shortcuts, bullet, to-do and numbered lists, Enter and Tab, undo, the selection toolbar, persistence after reload, and a typing-latency probe.
- **Not covered:**
  - `browser_viewport` has no touch emulation and no on-screen keyboard, so phone findings come from DOM measurements, screenshots and reading code. No finger or keyboard interaction was exercised.
  - The headless tool has no mouse-down/up primitive, so I could not drag-reorder. `plugins/page/plugins/editor/e2e/drag-reorder-verify.ts` covers it on desktop with a mouse.
  - Screenshots are in the session transcript only.
- Findings marked **(code)** come from reading the source, not from observing them.

## What already works (no gap)

- The slash menu opens on `/`, filters as you type and takes ↑/↓/Enter.
- Markdown shortcuts convert `- `, `[] `, `1. ` and `**bold**`.
- Enter on an empty list item exits the list. Tab indents.
- Undo and redo work with Cmd+Z. Control+Z does nothing on macOS, which is expected.
- The floating format toolbar appears on a keyboard selection, with B, I, U, S, code, link and colour.
- Edits persist across a reload.
- Typing latency was fine, about one frame per keystroke with about 5.6k DOM nodes on the page.

## Ranked gaps

### 1. Block rail is hover-only, so a phone has no way to add, move or act on blocks (P0, phone)

- **Repro:** at 390 px, the `+` and drag handle (block actions menu) never show, because nothing hovers on touch.
- **Cause (code):**
  - `editor/web/components/block-rail.tsx` hides the rail with `opacity-0 pointer-events-none group-hover/row:opacity-60 …`.
  - The drag sensor is dnd-kit's `PointerSensor` with a 4 px distance (`block-editor.tsx` ~435 and ~1866).
  - There is no touch sensor, no long-press activation, and no `touch-action` rule, so a finger drag scrolls the page instead.
  - Hover-only chevrons for expanded toggles share the same gate.
- **Desktop:** fine. The rail is at about 0.6 opacity on hover, but it is small (about 16 px targets).
- **Notion:** a long-press on the block grip gives drag and the block menu. On a phone the keyboard toolbar has "+" and "turn into", and a tap on a block selects it.

### 2. On a phone the page-tree sidebar toggle is covered by the app launcher (P0, phone)

- **Repro:** at 390 px, tap the sidebar icon at the top-left (24, 23). `elementFromPoint` there is the "All apps" button (32×32 at x=12). The "Toggle Sidebar" button (28×28 at x=10) sits underneath it, and tapping opens the app grid instead.
- **Effect:** the page list, search and favourites are unreachable on a phone. The only way to navigate between pages is the Recent links on the Pages home.
- **Cause:** the shell's brand/launcher and the Pages header toggle are laid out in the same corner. There is no phone drawer pattern for the sidebar.

### 3. The global action bar runs off the right edge of the screen (P1, phone)

- **Repro:** at 390 px, the bar's buttons are positioned at x ≈ 344, 378, 395, 397, 399, 401, 418 and 495, with widths of 32 or 78. Theme, View options, Builds, Getting started and the Wish pill lie beyond the 390 px viewport. The page does not scroll horizontally (`scrollWidth` 390), so they are clipped.
- **Effect:** Wish and the other items cannot be reached. Page actions are also squeezed. Only "…" (More actions) shows in the page header, and the "Page" type switcher and star seen on desktop are not visible.
- **Cause:** the global bar is a fixed-width right-aligned strip with no overflow collapse. The status dot (green circle, top right) sits over the header's right end.
- **Overlap:** this probably overlaps with task-1794626294-6x7u05, which covers the phone switcher and wish.

### 4. The content column wastes about 36% of the width on a phone (P1, phone)

- **Repro:** at 390 px, the editor is 250 px wide (x=76 to 326), so each side gap is about 76 px. At 16 px body text that is about 30 characters per line.
- **Cause (code):** the page body uses the desktop reading measure and large insets, with no breakpoint. The block rail gutter is reserved to the left (`left = seat.left − 20/40/60`) even when it is hidden.
- **Notion:** about 16 to 20 px side padding on a phone.

### 5. Tap targets are far below 44 px (P1, phone)

| Control | Size |
| --- | --- |
| To-do checkbox | 14×14 px |
| Header buttons | 28×28 px (toggle, copy ID, "…") |
| Rail `+` / handle | about 16 px |
| Format toolbar buttons | about 28 px (desktop screenshot) |

- **Cause:** all of these use the desktop density. There is no coarse-pointer variant.

### 6. The slash menu and selection toolbar are not placed for a phone (P1, phone, unverified)

- **Seen on desktop:**
  - The slash menu opens at the page's left edge, below the line, not at the caret.
  - It is 220 px wide, shows 8 items and is clipped with a fade.
  - The format toolbar is a fixed-size floating pill above the selection.
- **On a phone, expected from code and size:**
  - The pill is about 240 px wide and would overlap the OS selection menu.
  - The slash menu would be covered by the on-screen keyboard.
- **Cause (code):** I found no `visualViewport` handling or keyboard inset anywhere in `editor/web`, so nothing repositions floating UI above the keyboard.
- **Notion:** a bar above the keyboard with common block types, "turn into", mention and undo.

### 7. No empty-line hint or visible way to start a block (P2, both)

- **Repro:** a fresh page shows only "Untitled" and an empty body with no "Press / for commands" placeholder, and no placeholder on empty blocks.
- **Effect:** on a phone, with no `+` available (gap 1) and no hint, `/` is undiscoverable.
- **Notion:** the empty-line placeholder, plus a tap on the empty area below the last block adds a new block.

### 8. Auto-icon shifts the page by 84 px while the user types (P2, both)

- **Repro:** create a page, type a title and a few blocks. A 🎯 icon appears and every block moves down by 84 px.- **Cause:** the `page/auto-icon` plugin assigns an icon after content exists. The icon row is added to the flow instead of reserving its space.
- **Effect:** the layout jumps under the caret or a finger.

### 9. Text selection by double-click or long-press may not work (P2, unverified)

- **Repro:** a double-click on a word in a bullet produced no selection and no toolbar (`getSelection()` was empty). Shift+Arrow selection worked.
- **Not confirmed:** this may be a headless-automation artefact. It needs a real mouse and a real touch check. Notion selects the word on double-click and long-press.

### 10. Unexplained text loss (P2, not reproduced)

- **Seen once:** a block that read `toggle? bold text ZZZ` later read just `toggle`. In between I used Meta+Z, Tab on another block, ArrowDown ×3, End, and typed `\n---`.
- **Retry:** a later edit and reload persisted correctly.
- **Next step:** this needs a careful repro under real keyboard input. It may have been my input sequence, such as `\n` in `type`, or a caret-authority interaction.

### 11. Small desktop gaps (P3)

- **`> ` shortcut:** typing `> ` converts to a block whose prefix disappears, but it is not obvious that it is a toggle. The block had no arrow in the screenshot.
- **Rail size:** the `+` and drag handle are about 0.6 opacity and about 16 px, small compared with Notion's.
- **Rail alignment:** the rail sits 60 px left of the text, so a hover that starts at the text edge crosses empty space before reaching it.
- **Format toolbar:** it has no "turn into", comment or mention entry.
- **Notifications:** a "Slow boot hook" toast sits over the bottom-right corner of the editor on first load. This is the app's shell and not specific to Pages.

## Recommended order for the phone prototype

1. Sidebar as a phone drawer (gap 2), with the global bar collapsed (gap 3).
2. Narrow content margins (gap 4) and coarse-pointer sizes (gap 5).
3. Touch block actions: long-press grip and tap-to-select (gap 1), and a keyboard-docked toolbar (gap 6).
4. Placeholders (gap 7) and the icon layout shift (gap 8).
5. Re-verify gaps 9 and 10 on a real device or with touch emulation (`screenshot.ts --viewport 390x844 --touch`).
