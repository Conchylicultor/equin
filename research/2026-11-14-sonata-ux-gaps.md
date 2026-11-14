# Sonata app: usability gaps on desktop and phone

Date: 2026-11-14. Task: investigation only, no fixes.

Method: drove my own build with the headless `browser_*` tools on the library and one chord-grid song ("Modulation Em -> E"). Viewports: 1280x800, 390x844 (portrait) and 844x390 (landscape). Plugin code was read only to explain causes.

**Not verified.** The headless browser has no touch input and no audio output. These were not exercised and need a real device or `screenshot.ts --touch`:
- Multi-touch chords.
- Tap-to-sound latency.
- Glissando and drag across keys.
- Audio quality.

"Likely cause" entries below are inferences from screenshots and a quick code read. They are not confirmed.

## Ranked gaps

### 1. Phone portrait: the "Song" side pane opens over the whole screen on song open (High, phone only)
- **Repro:** at 390x844, open any library song.
- **Result:** the Song pane (Chord Grid, Tracks, Progression, ...) fills the viewport. The player, roll and keyboard are hidden behind it. The user has to find the small X to see the song.
- **Desktop:** the pane is a 1/3-width side panel and is acceptable there, though it still covers the right third of the roll.
- **Likely cause:** the pane is a Miller-style column or overlay with no phone presentation, and it is open by default.

### 2. Phone: the 88-key keyboard is unplayable by touch (High, phone)
- **Repro:** 390 wide, close the pane, look at the bottom keyboard.
- **Result:** all 88 keys are squeezed into about 315px. A white key is about 4px wide and the black keys are about 2px. The keyboard also stops short of the right edge, leaving a gap.
- **Reference:** a touch piano key should be at least 40px wide (about 8 octaves is about 330px).
- **Missing:** no zoom, no scroll or pan of the keyboard, and no "N octaves around the playhead" mode.
- **Likely cause:** the keyboard fits the full pitch range to the width.
- **Note:** hand-play exists (`useLivePlay`, `held` set in `piano-keyboard.tsx`), so the code path is there. Touch behaviour of that path is unverified.

### 3. Phone: the top toolbar overflows and collides with the brand (High, phone)
- **Repro:** 390 wide, open a song.
- **Result:** the view-option pill (grid, melody, "Piano roll", doc, speed 100%, ...) is wider than the screen. It overlaps the app brand icon and the back arrow, hides the song title, and is clipped on the right. Speed, metronome, transpose, volume and fullscreen are unreachable. The health dot sits half-covered.
- **Desktop:** fine.
- **Likely cause:** `view-options` and `transport-bar` render one fixed-width strip with no collapse or overflow menu.

### 4. Phone: the scrubber is about 50px wide (Medium-High, phone)
- **Repro:** 390 wide, look at the transport strip.
- **Result:** the play button, time readout, loop button and chevron take almost all of the row. The progress rail is a tiny stub.
- **Hover-only features:** section labels and loop buttons are revealed on hover (`group-hover/scrub`, label-lane hover), so touch users cannot reach them. Hover previews of bars also cannot be reached by touch.
- **Likely cause:** fixed-size controls beside a flex rail, plus hover-gated affordances in `progress/scrubber`.

### 5. Phone landscape: almost no room for the roll (Medium-High, phone landscape)
- **Repro:** 844x390, open a song.
- **Result:** the header, the transport strip and the keyboard (about 90px) leave only about 100px for the falling-notes roll. Notes are visible for a split second.
- **Side rail:** the side action rail on the right is clipped. Its top and bottom icons are cut and it is not scrollable.
- **Missing:** no auto-hide chrome and no "fullscreen player" that hides the header and transport strip.
- **Likely cause:** all chrome is permanent, and the rail has no overflow handling.

### 6. Phone: the side action rail floats over the roll (Medium, phone)
- **Repro:** 390 wide, with the pane closed.
- **Result:** a tall vertical pill of 9 icons covers the right 12% of the roll and the notes under it.
- **Missing:** icons have no labels. The only way to know what one does is to open the pane.
- **Likely cause:** the rail is the closed form of the Song pane.

### 7. Phone: library view tabs collapse to a single icon (Medium, phone)
- **Repro:** 390 wide, open `/sonata`.
- **Result:** the Cards, All, Longest, Composed and Recent view tabs show only the active icon. It is not obvious that other views exist or how to switch.
- **Desktop:** the tabs are labelled and fine.
- **Library on phone otherwise:** the card list works as a single column and is the best phone surface. The chord cards are large, legible and easy to tap.

### 8. Desktop: the Song pane open by default hides the roll's right third (Low-Medium, desktop)
- **Repro:** 1280 wide, open a song.
- **Result:** the keyboard still spans the full width under the pane, while the roll above is narrowed to 2/3. Keys under the pane, such as C7 to C8, no longer line up with the note lanes above them.
- **Likely cause:** the pane overlaps the roll while the roll's width is reduced by `lane-insets`.

### 9. Onboarding and empty states (Low, both)
- **Result:** there is no first-run hint for what the pane, the "Piano roll" lens or the rail do. The first thing a new user sees is a grid of chord cards with no explanation.
- **Not tested:** the true empty library state (no songs). My data already has 13 songs.

### 10. Small touch targets across chrome (Low-Medium, phone)
- **Result:** icon buttons in the toolbar, the rail and the loop controls look about 24-32px, which is under the usual 44px touch target.
- **Likely cause:** the app uses a desktop density throughout.

## Suggested priority for the phone prototype
1. Present the Song pane as a bottom sheet and keep it closed by default (gap 1).
2. Make the keyboard scrollable or zoomable at 40px or larger keys (gap 2).
3. Collapse the toolbar into an overflow menu (gap 3).
4. Fix the scrubber width and its hover-only controls (gap 4).
5. Auto-hide chrome in landscape (gap 5).
6. Then gaps 6, 7 and 10.
