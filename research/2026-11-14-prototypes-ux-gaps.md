# Prototypes app: usability gaps on desktop and phone

Date: 2026-11-14. Task: investigation only, no fixes.

Method: drove the app on main (`http://equin.localhost:9000/prototypes`, read only) with the headless `browser_*` tools at 1280x800 and 390x844. I covered the gallery, a prototype's canvas (Bookmark Jukebox, `/prototypes/proto/proto-1792801597-cohp0r`), the options picker, version list, frame actions, size chip, Compare and full screen. Code was read only to explain causes.

**Not verified.**
- The headless browser reports `(hover: hover)` as true, so hover-only affordances are judged from the CSS, not from a real touch device.
- Not tested: real touch scrolling inside the prototype iframe, iOS Safari, the on-screen keyboard.
- Not driven: `/demo`, Launch buttons (main refuses agent writes), and the New prototype flow.
- Screenshots were taken at 390x844 and are in the session's tool results, not committed.

## What works
- The gallery collapses to a single column at 390 wide, with no horizontal scroll. Cards are large and readable.
- The canvas toolbar, options popover, version list, frame menu and size popover all open as popovers that fit the screen. The size popover is thorough (presets, width slider, zoom, Fit, Whole page).
- Phone preset: on a phone it reads "390 x 844 at 79%", i.e. it fits.

## Ranked gaps

### 1. Phone: the global action bar, including Wish, is off-screen, so there is no way to ask for a change (High, phone)
- **Repro:** at 390x844, open any prototype. Only the health dot (x=344) is visible. Notifications sits at x=378, Theme at x=395, View options at x=397. Wish is not even rendered in the DOM there.
- **Result:** the Prototypes workflow is review then "ask for a change". On a phone you can review but cannot give feedback from the page. The prompt is only reachable by going back to a desktop.
- **Likely cause:** the shell's global action bar is a horizontal strip sized for desktop and clipped, not collapsed (same root cause as in the Keyboard Party report).
- **Idea:** a thumb-reachable feedback affordance on the canvas: a floating "Request change" button that opens the Wish composer with the prototype and version as context.

### 2. Phone: "Phone" and "Responsive" presets are the same thing, and desktop-design prototypes are shown squeezed (High, phone)
- **Repro:** open Bookmark Jukebox at 390 wide. Responsive gives a 350x668 frame: a desktop two-column layout (sidebar plus content) crushed to 350 px. Choose Phone: 390x844 at 79%. The content is cut at the right edge (search box, "Shuffle everything" button). Text becomes small.
- **Result:** the review experience of a desktop prototype on a phone is poor, and the canvas offers no useful size: Laptop or Desktop presets "Fit" to a tiny zoom, which is illegible.
- **Missing:** a pan and pinch zoom of the canvas. The size popover has a zoom slider, but no gesture. The frame is inset 20 px each side, so the phone viewport is never fully used.
- **Likely cause:** the frame is a fixed-size box in a canvas padded for desktop chrome (toolbar above, size chip below).
- **Idea:** on a phone, default to a frame that fills the screen edge to edge (no padding or rounded corners) with the chrome collapsed into one handle. Offer pinch-zoom for large presets.

### 3. Phone: the canvas toolbar cramps to 24 px targets and the floating compare buttons cover the prototype (Medium, phone)
- **Targets:** version arrows are 20x20, the options reset button 24x24, color swatches 20-22 px, Dark/Light toggle 46x24, In URL switch 77x16. All below the 44 px touch minimum. The gallery card actions are 30x30.
- **Overlap:** two floating buttons (Add a frame to compare 30x30 at x=330, y=402, and Compare with Real app below it) sit over the right edge of the prototype in the middle of the screen. They hide content and are easy to hit by accident while scrolling the prototype.
- **Likely cause:** these are desktop-density controls (control size provider) with no coarse-pointer sizing.
- **Idea:** coarse-pointer sizing for the toolbar and swatches, and moving compare into the Frame actions menu on a phone.

### 4. Phone: gallery card actions are hover-only (Medium, phone)
- **Repro:** at 390 wide, each card has Edit tag, Mark as done, Open in a new tab and Delete. Their container computes to `opacity: 0` at rest and is revealed on hover (the card's float toolbar). On a phone with no hover they are not discoverable. On a real touch device a tap opens the prototype, and the actions can only appear after a "hover" emulated by a first tap, if at all.
- **Missing:** a touch path to Mark as done and to Delete (long-press menu or a swipe).
- **Likely cause:** the cover-frame card's floating actions use `group-hover` reveal (`data-view/cover-frame`).
- **Desktop:** fine.
- **Idea:** show the actions at rest on coarse pointers, or collapse them into one "..." button on the card.

### 5. Phone: full screen mode overlaps the toolbar on the prototype and keeps desktop hints (Medium, phone)
- **Repro:** Frame actions then Full screen. The toolbar (options, version, Exit, "Esc" chip) draws translucent over the top of the prototype; its text collides with the prototype's own search box. The size chip pill and the compare buttons stay on screen.
- **Result:** the prototype is not seen clean, and exiting says "Esc", a key a phone does not have. Menu entries show keyboard hints (R for Restart, F for Full screen).
- **Likely cause:** present mode (`present` plugin) reuses the desktop chrome, with idle-hide on pointer events (`use-pointer-idle`), which never idles on touch.
- **Idea:** a clean full screen with a small handle, tap to bring the chrome back, no key hints on coarse pointers.

### 6. Both: the version list gives no preview, no diff and no restore (Medium, both)
- **Repro:** open the version button: "2 versions": v1 (the request text, truncated at one line: "Can you read my chrome bookmarks ? Try to understa...") and v0 Baseline. There is no way to see what changed between them.
- **Compared with Figma/Framer:** version history there offers thumbnails, naming, restore and side-by-side compare. Here the only way to compare versions is to flip between them and look. The separate Compare feature compares a prototype with the real app, not version with version.
- **Phone:** the list is tappable but the truncated prompt hides what each version is.
- **Idea:** two-line prompts, a thumbnail per version, "Compare with previous" which opens the existing compare frames.

### 7. Both: "Compare with real app" is an agent launch, and the declared mock link is invisible when absent (Low-Medium, both)
- **Repro:** on a prototype with no declared real app, the button opens "Add the real app to compare with", which launches an agent. The label does not say it costs an agent run. On a prototype with a declared app, the button name is the app name ("Compare with Real app" here is the placeholder).
- **Idea:** disable with a hint, or label the action "Find the real app (starts an agent)".

### 8. Both: options picker discoverability and "In URL" (Low, both)
- **Repro:** Options pill shows "Dark . Amber". The popover has Theme and Accent plus an "In URL" switch and per-row "one frame per" icons (24x24) whose meaning appears only in a tooltip (no hover on phone).
- **Result:** the "one frame per value" (a comparison matrix) is a powerful feature but undiscoverable by touch. Row actions are drawn at 40% opacity until hover (`rowActionClass`).
- **Idea:** label the icon in the row or in the popover footer.

### 9. Desktop: browser console shows many 404s when entering full screen (Low, desktop and phone)
- **Repro:** enter Full screen: 23 `Failed to load resource: 404` errors are logged at once. The prototype itself still renders. They look like repeated asset or thumbnail requests; I did not trace them.
- **Needs:** a look at the network log to see which URLs.

### 10. Phone: gallery view tabs are clipped (Low, phone)
- **Repro:** at 390 wide the view bar shows "Galle" cut off with Done, Recently edited and Trash scrolled out of sight, and no visible scroll cue.
- **Idea:** a compact view switcher (a select) on narrow widths.

## Summary for the follow-up phone prototype
Priorities: (1) a thumb-reachable "Request change" action, (2) a phone-first canvas that fills the screen with pinch zoom, (3) touch-sized controls, with card actions and compare moved into menus, (4) a clean full screen, (5) a richer version list with previews.
