# Agent manager: usability gaps on desktop and phone

Investigation, not a fix. Method: drove the real app on main (read-only browsing, no writes) with the `browser_*` tools at 390×844 (phone) and 1280×800 (desktop), on 2026-11-14. Surfaces: home prompt, sidebar, task list, task detail, conversation view, Wish popover. `/demo` is the same app on made-up data, so it was only used to find the entry point.

Not exercised: the on-screen keyboard (headless, so no virtual keyboard) and real touch input (`--touch`); those findings are inferred from measured layout. Nothing was built, so no write flow (launching an agent, submitting a Wish) was run.

Severity: **S1** blocks a core flow, **S2** makes a core flow clearly worse, **S3** polish.

## Ranked gaps

### 1. [S1, phone] The Wish popover is 560 px wide on a 390 px screen — its send button is off-screen
- **Repro:** phone viewport, any page. Tap the health dot (top right) to expand the action strip, then tap **Wish**.
- **Observed:** `popover-content` measures x=5, width=560. The textarea and its toolbar are clipped at the right edge; the submit control is not reachable. Filing a task from a phone, the point of Wish, does not work.
- **Likely cause:** a fixed popover width with no `max-width: calc(100vw - …)`. The Wish popover sits in the global action bar, and the bar's contributions were not given a phone layout.
- **Desktop:** fine.

### 2. [S1, phone] The sidebar (the list of tasks and conversations) can only be opened by a tap that lands on the app launcher
- **Repro:** phone viewport, `/agents`. Tap the sidebar icon at top left (x≈22, y≈22).
- **Observed:** the tap opens the **app launcher** menu, not the sidebar. `elementFromPoint` and the click log show `floating-app-launcher.tsx`'s fixed `left-3 z-popover` band intercepting pointer events over `[data-sidebar=trigger]`. On desktop the same spot shows the sidebar icon at rest and the launcher on hover; touch has no hover, so the launcher always wins. The sidebar opened only through a programmatic `click()` on the trigger.
- **Likely cause:** two overlapping controls in the same corner. The launcher is a floating overlay (`apps-core.overlay`) positioned on top of the app shell header's own toggle.
- **Impact:** a phone user has no discoverable way to reach tasks or other conversations. This is the main reason the task list is unusable on a phone.

### 3. [S2, phone] Navigation hides the destination: the sidebar sheet does not close after you pick something
- **Repro:** open the sidebar (programmatic), tap a conversation or **Tasks**.
- **Observed:** the route changes (URL and title update) but the sheet stays open over the content. You have to tap the dimmed area to see where you went. Reproduced twice (a conversation, then Tasks).
- **Likely cause:** the mobile sidebar sheet has no close-on-navigate.
- **Desktop:** n/a (persistent sidebar).

### 4. [S2, phone] The global action bar is a collapsed dot that expands into a strip wider than the screen
- **Repro:** phone, tap the green health dot at top right.
- **Observed:** theme, settings, Building, help, Wish, element picker unroll leftward in one row about 500 px wide; the leftmost items are clipped (a red dot at x=0). The row is an absolutely-positioned `w-max` block, 32 px high targets, nothing wraps or scrolls. It also sits on top of each pane's own header actions (the close "x" on task detail is covered by the dot).
- **Likely cause:** the bar was designed as a floating desktop strip. There is no phone variant.
- **Related:** Wish, the primary entry point, is at the top right, the least reachable spot for a thumb, and is hidden one tap deep.

### 5. [S2, phone] The conversation view leaves little room to read
- **Repro:** phone, open a long conversation.
- **Observed (resting, before the keyboard):**
  - Header is two rows (title, model chip, ⋯; then a row of 8–9 icon-only buttons, 26 px each: attempt view, tasks, file explorer, pages, artifacts, branch name, review...).
  - A sticky "first prompt" banner (~80 px) stays pinned below the header while scrolling.
  - The composer takes ~270 px, plus a draft textarea (the yellow "Tentative title" box) above it and a status row below.
  - The transcript gets about 460 of 844 px. With the on-screen keyboard (~300 px) it falls to roughly 150 px. This last number is an estimate; the keyboard was not run.
  - A floating context/cost chip ("146k ctx · 33k out · $5.27") and the scroll-to-bottom chevron overlap transcript text.
  - A scroll minimap strip on the right edge overlaps text at 390 px.
- **Desktop:** the same chrome is fine because the viewport is large; the only confusion is two stacked editors (queued draft above the composer) with no label saying which sends.

### 6. [S2, phone] Tap targets are far below 44 px almost everywhere
- Measured on the conversation view: 228 of 278 visible buttons/links are under 44 px in one dimension; the minimum height is 8 px. Header and toolbar icons are 26×26; composer toolbar (attach, workspace, supervisor, preprompt) 26×26; send button 29×29; tool-call "Expand" rows 346×28; checklist edit/send tabs 28 px wide; the action bar's 32 px buttons.
- Nothing is hover-only at rest (tool rows and toolbar icons are always visible), but the sidebar row's pin and ⋯ appear only on hover/active row, which a touch user can't get to.
- **Likely cause:** one density for all inputs; no `pointer: coarse` sizing.

### 7. [S2, phone] The task list is a 3-column table that starves the title column
- **Repro:** phone, `/agents/tasks`.
- **Observed:** columns Title / Supervisor / Updated stay on screen; the Supervisor column is empty for most rows but keeps its width. Nested rows are indented 24 px per level, so level 3–4 titles show as "Revert ..." or "How t..." (about 8 characters). No search or filter control is visible, though the list has 6,966 tasks.
- **Likely cause:** `DataView` list view with fixed-width columns and no compact/card mode below some width.
- **Desktop:** fine.

### 8. [S3, phone] Task detail is a long stack of cards with the title clipped
- **Observed:** open a task: Dependency tree, then Task card, then Triage, then Prompt. The task title is a single-line input that clips ("Add conversation pane to task vie"). About 450 px of metadata rows (Status, Track, Supervisor, Mandate, Author, Created, Closed) come before the Prompt card, which is the thing you edit. There is no back button; only expand and close icons. It does read as a navigable screen (full-width, stacked) rather than a squeezed Miller column, which is the right instinct.
- **Desktop:** fine.

### 9. [S3, phone] Wide content in transcripts: markdown tables
- **Observed:** a 5-column table (Score / Comments / Format / Post / Hook) is wider than the screen and clipped at the right edge; the "Hook" column is cut. There's no visible cue that it scrolls. Links wrap one word per line ("used claude code to figure out…"), making rows very tall.
- **Likely cause:** table is laid out at natural width with the transcript's `overflow-x-hidden`.

### 10. [S3, both] Home prompt: tiny toolbar, status text unexplained
- Phone: the four composer icons (attach, workspace, supervisor, preprompt) have no labels and are 26 px; "48 need you / 10 running / 6,966 total" are plain text with no tap behaviour I could find. The home screen is mostly empty space above the composer (nothing recent to resume).
- Desktop: same, but less costly.

### 11. [S3, both] Dev toasts cover the bottom of the screen
- "Slow operation detected" toasts (with a Fix button) appear bottom-centre over the composer or content. On a phone they cover ~100 px and on this instance reappear often. A developer-audience feature, but on phone it sits on the thumb zone.

## What worked

- Conversation transcript text reflows well; tool-call rows are compact one-liners that expand in place (Bash showed its input).
- The sidebar sheet itself, once open, is readable and grouped (Pinned / Polished / Perfs, bugs / Park).
- Task detail stacks full-width (no horizontal Miller layout on phone).
- No page-level horizontal scroll (`scrollWidth` = 390).
- The desktop layout is solid: sidebar, header chips, transcript, composer are well proportioned.

## Suggested priorities for the phone prototype

1. Fix navigation: one corner owner for launcher and sidebar toggle (or a bottom bar with Home / Tasks / Conversations / Wish), and close the sheet on navigate (gaps 2, 3).
2. Give Wish a phone form: a bottom sheet at 100% width, reachable from a thumb-zone button (gaps 1, 4).
3. Design the conversation screen for phones: one header row with a ⋯ menu for the toolbar, no pinned prompt banner, a compact composer, overlays that don't cover text (gap 5).
4. Coarse-pointer sizing, 44 px targets (gap 6).
5. Task list as cards or compact rows, with search; task detail with Prompt above metadata (gaps 7, 8).

## Open questions / not verified

- Real-keyboard behaviour (viewport resize vs overlay, whether the composer stays visible).
- Whether the sidebar opens by swipe on a real touch device.
- Write flows (Wish submit, Start agent) — needs my own build.
