# Files app: usability gaps on desktop and phone

Date: 2026-11-14. Task: investigation only, no fixes.

Method: drove the File explorer in the in-browser demo (`http://equin.localhost:9000/demo`, "Enter equin", Files) with the headless `browser_*` tools at 390x844 and 1280x800. I opened a folder and every sample file kind (png, mid, pdf, md, webm), tried right-click, F2, the row "⋯" menu, the header overflow, the Trash and the sidebar. Code was read only to explain causes.

**Not verified.** No real touch, no iOS Safari, no on-screen keyboard, no PDF plugin in headless Chromium:
- PDF rendering (blank here, see gap 7).
- Long-press, drag by touch, pinch, swipe-back.
- The 403 console error on the desktop pass was not investigated.

The demo has one fixed made-up tree (Home with Documents, Music, Pictures and 5 files). Only the in-browser file system exists there; the computer's disk (Downloads, equin checkout, Trash) does not.

## What works
- Phone: folder navigation by tap, a breadcrumb in the header, and an open file replaces the listing (full-screen preview with an X). This is the right model.
- Previews render well on a phone: markdown (table wraps), image (centred), video (plays, controls hide), MIDI (falling notes, piano and a floating player pill).
- Desktop: sidebar, back / forward / up, filter, hidden-files toggle, Kind and Modified columns, a listing + preview split.

## Ranked gaps

### 1. Phone: the sidebar (Favorites, Locations) cannot be reached (High, phone)
- **Repro:** at 390x844 open Files. The header's top-left square is the "Toggle Sidebar" button, but the floating app launcher ("All apps") is drawn on top of it. `elementFromPoint(41, 89)` returns the launcher's `floating-bar-band` div. Tapping opens the app grid, never the sidebar.
- **Result:** Home and Trash are unreachable; a pinned folder cannot be opened. Calling the toggle by script shows a good slide-over sheet, so only the button is covered.
- **Likely cause:** `plugins/apps-core/plugins/app-launcher/web/components/floating-app-launcher.tsx` fixes the launcher at `left-3` on every phone app, and Files puts its sidebar toggle in the same corner.
- **Idea:** one top-left slot for both, or move the sidebar into a tab/segment bar.

### 2. Both: almost no file operations (High, both)
- **Repro:** right-click a row: nothing (no context menu). F2, Delete: nothing. The row "⋯" menu has only **Copy path** and **Add to Favorites**. The header has no New folder, upload, or sort control.
- **Missing vs Finder / Drive / iOS Files:** rename, new folder, delete or move to Trash, duplicate, download / share, upload, sort by column.
- **Phone:** there is also no way to select several rows (no checkbox mode, no long-press): multi-select is ⌘/Shift-click and ⌘A only, and moving a file is drag only (the e2e script `browser/e2e/select-and-move.ts`), which a finger cannot do.
- **Likely cause:** the explorer is a browser/previewer, writes only exist as "drag to move" and the git/extract actions (`row-actions.tsx`).

### 3. Phone: touch targets are too small, row actions hide until hover (High, phone)
- **Repro:** rows are ~30 px tall (iOS Files ≈ 56, minimum 44). The "⋯" button is ~16 px wide and drawn on hover only; on touch there is no hover, and where it shows it covers the Size column (e.g. "Mendelssohn … 6" is clipped under it).
- **Likely cause:** the same dense DataView row as desktop, with no phone density.

### 4. Phone: navigation controls are buried (Medium, phone)
- **Repro:** in the header "⋯" sits Back, Forward, Enclosing folder, Show hidden files, and a view-options button ("1"). The pencil (edit path) shows only at times. There is no visible back arrow; going up means tapping a breadcrumb crumb or opening the overflow. Backspace works only on a keyboard.
- **Result:** the most frequent action in a file app (go back) costs two taps, and the OS back gesture leaves the demo rather than going up (not verified on a device).
- **Idea:** a back arrow beside the title, as in iOS Files, with the title as the current folder name.

### 5. Both: the Trash is a dead end in the demo and the empty state names a missing home folder (Medium, both)
- **Repro:** desktop, click Trash under Locations. The pane is blank with no breadcrumb and the text "Your home folder isn't available in this version of the app — it needs equin running on your computer."
- **Result:** a visitor reads this as a bug. The Trash entry should not be offered where it cannot open.
- **Likely cause:** `places/web/internal/places.ts` offers the Trash from `~/.Trash`, but the demo's `~` is the browser's storage, so listing it fails. Real Files has the same item with no delete/restore action to put anything in it.

### 6. Phone: no density or layout of its own for the listing (Medium, phone)
- Name column truncates at ~230 px ("Mendelssohn - Song without Words …", "Chopin - Nocturne Op. 48 No. 1.mid" barely fits); Size shows, Kind and Modified are dropped without a way to see them.
- No grid or thumbnail view; images are listed as an icon, never as a thumbnail (Drive and iOS Files show thumbnails). Sort and group controls are hidden behind the "1" button.

### 7. Phone: PDF preview is blank here and probably poor on iOS (Medium, phone, unverified)
- **Repro:** open `Fado night ticket.pdf`: an empty pane. The DOM is an `<iframe src="blob:…">` (`file-viewer/plugins/pdf`), so it needs a browser PDF viewer. Headless Chromium has none, so this may be an artefact.
- **Risk:** iOS Safari shows only the first page of a PDF in an iframe, with no scroll or zoom inside the frame. Needs a real iPhone. There is no loading or failure state either way.

### 8. Phone: image and video previews have no gesture or navigation (Medium, phone)
- Image: fits and centres, but no pinch zoom, double-tap zoom, or fit/100% toggle; a small image is not enlarged.
- No previous / next file (swipe or arrow) in any preview: browsing photos means close, tap, repeat.
- The header shows `~ · 4.5 KB · Today` truncated; markdown's was clipped to "Toda".
- MIDI: the seek bar is ~100 px wide; the floating pill covers the top of the note roll. The MIDI preview starts playing on open (pause icon visible), which on a phone surprises the user and may be blocked by the audio-unlock policy.

### 9. Demo: opening a deep link or reloading loses the place (Low, both)
- **Repro:** navigate straight to `/demo/at/files/browse/~;fs=browser/preview/Alfama%20at%20dusk.png`: the splash screen with "Enter equin" appears, and a tap on it is needed before the linked file shows (it then opens at that file, so the link survives). A shared link therefore never shows the file at once.
- The demo's notification toasts (Endpoint call-rate spike, "Dismiss all (4)", 141 unread) cover the bottom third of the Files list on first open at phone size.

### 10. Desktop: smaller issues (Low, desktop)
- The "Switch apps" hint tour popover opens on first use over the app's own sidebar.
- Nothing shows selection count beyond the status line; no Get info / properties pane, no Size sort in the header (clicking column heads untested).
- No keyboard Enter-to-open / Space-to-quick-look verified (only Escape, Backspace and ArrowDown are declared in `file-browser.tsx`).

## For the phone prototype
1. One top bar: back arrow, current folder title, ⋯. The sidebar becomes a Browse screen (Favorites, Locations) reached from a bottom tab or the title, never behind the launcher.
2. 56 px rows with a visible ⋯ and a selection mode (long-press, checkboxes, bottom bar: Move, Copy, Rename, Delete).
3. Create the missing actions (New folder, Rename, Delete / Trash, Download) for both sizes; hide the Trash where it cannot exist.
4. Preview viewers get swipe prev/next, pinch zoom for images, and a PDF fallback ("Open") for iOS.
