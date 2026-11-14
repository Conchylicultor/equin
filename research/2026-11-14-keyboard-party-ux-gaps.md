# Keyboard Party app: usability gaps on desktop and phone

Date: 2026-11-14. Task: investigation only, no fixes.

Method: drove the app on main (`http://equin.localhost:9000/keyboard-party`; it only reads) with the headless `browser_*` tools at 1280x800, 390x844 and 844x390. I tapped, pressed keys and ran a 40-tap mash script. Code was read only to explain causes.

**Not verified.** The headless browser has no real touch, no on-screen keyboard, no audio output and no iOS Safari. These need a real device:
- Sound unlock on iOS and Android.
- Speech voices.
- Real multi-touch.
- Animation smoothness on a phone GPU. My frame timings come from software rendering and are only indicative.
- `/demo` was not driven; the stage code is the same.

## What works
- Desktop: a key press plays a big letter, a picture, a word and a sound. This is delightful.
- Phone: a tap anywhere plays a random letter at the tap point, and a bead trail forms at the bottom. Portrait and landscape both render correctly.
- Synthesized audio (no samples) and a compressor mean a mash does not clip.
- A mash is bounded: `MAX_NODES` is 420 lively / 160 calm, and the layer drains to 0 nodes within 6 s.

## Ranked gaps

### 1. Phone: the child can never press a letter, tapping gives a random one (High, phone/tablet)
- **Repro:** at 390x844, tap the screen. A random A-Z letter plays (`onPointerDown` in `party-stage.tsx` picks `Math.random()`).
- **Missing:** the page has no `input` or `contenteditable`, so the OS keyboard never appears (verified: zero inputs in the DOM). Tablets with a hardware keyboard work. A phone has no way to ask for "B", digits, space, arrows, or the special effects.
- **Why it matters:** the toy's core promise is "this key does this". On a phone it is a random-letter machine. A child cannot learn that B makes Ball.
- **Likely cause:** by design the stage listens only to `keydown` on a focused div.
- **Idea:** an on-screen A-Z / 0-9 key strip, drawn big and in the same palette, as the phone's input. Alternatively, tapping a bead repeats its letter.

### 2. Phone: the grown-up controls and global action bar are a mash hazard (High, phone)
- **Repro:** at 390x844, a child taps the top-left 32px buttons or the health dot at top right.
- **Result:** the top-left brand button ("All apps") sits at (10,10) and opens the launcher, which leaves the toy. Its neighbours open the settings popover and Lock. Nothing asks for a grown-up's confirmation.
- **Result:** the global action bar (health dot, notifications with "130 unread", theme, view options, builds, wish) is drawn on the toy. At 390 wide only the health dot is on screen. The other buttons are laid out at x=378 to 527 and are partly or fully off-screen.
- **Desktop:** the same buttons exist but a keyboard-mashing child does not hit them. The controls are at 45% opacity and are not exposed to a keyboard.
- **Likely cause:** `.kp-controls` is absolutely positioned in the stage corner and stops `pointerdown` propagation so it keeps its own taps. The shell adds no phone chrome.
- **Idea:** hide the corner controls behind a deliberate gesture: press and hold 2 s on a corner, or a two-finger hold.

### 3. Phone: Lock cannot work, and there is no way to stop a child leaving by swipe or home bar (High, phone)
- **Repro:** the Lock button calls `stage.requestFullscreen()`. iPhone Safari does not support element fullscreen. Chrome on Android supports it.
- **Result:** the lock icon does nothing on iPhone. The Keyboard Lock API (`navigator.keyboard.lock`) is Chromium desktop only, so on phone Lock only toggles fullscreen at best.
- **Missing:** on the iPhone, the tab bar, the browser back swipe and the home bar are all still available to a child. A PWA install gives full screen, and `app-manifest` exists, but the manifest's display mode was not checked.
- **Likely cause:** Lock is designed around the desktop keyboard.

### 4. Phone: the stage `touch-action: none` gives no pinch zoom, double-tap zoom or overscroll, but nothing blocks gestures at the edge (Medium, phone)
- **Repro:** the stage has `touch-action: none` (verified), so the child cannot pinch-zoom the toy, which is correct. Edge swipes (iOS back swipe, Android back gesture) are still browser-level.
- **Result:** a back gesture leaves the app without any warning. The `viewport` meta is plain (`width=device-width, initial-scale=1.0`, no `viewport-fit=cover`), so on a notched phone in landscape the stage and the bead trail are not laid out against the safe areas.

### 5. Phone: sound unlock and speech are untested and fragile (Medium, phone, not verified)
- **Code:** `PartyAudio` creates the `AudioContext` on the first sound. That follows a tap, which is the required gesture, and the code also calls `resume()` when suspended. This is good.
- **Risk 1:** the first tap's tones are scheduled on a context that is still suspended, so the very first sound can be lost or late on iOS. The `resume()` is fired without awaiting.
- **Risk 2:** iOS mutes Web Audio when the hardware silent switch is on. A child will hear nothing and nothing in the UI says so.
- **Risk 3:** speech uses `speechSynthesis.speak` (`audio.ts:133`). It `cancel()`s before each utterance, which on iOS can drop the new utterance. Voices load asynchronously, and `getVoices` / `onvoiceschanged` is never used, so the first words can fall back to a default voice.
- **Needs:** a test on a real iPhone and an Android phone.

### 6. Phone: multi-touch works only as separate taps, and each tap is random (Medium, phone)
- **Repro:** `onPointerDown` fires per pointer, so two fingers play two effects. This works in principle, but I could only dispatch synthetic pointer events (5 pointer ids), not real touches.
- **Result:** there is no multi-finger chord, and no drag or trail effect (`pointermove` is unused). A toddler who slides a finger gets nothing between taps.
- **Idea:** let a drag leave a trail, as in a drawing toy.

### 7. Both: the mash cost is bounded but the frame rate drops under it (Medium, both)
- **Repro:** 40 synthetic taps in 1.6 s on the 390x844 stage.
- **Result:** the layer peaked at 420 nodes (the lively cap, about 10 nodes per tap). Over the next second the average frame was about 32 ms (max 67 ms) in headless software rendering, so roughly 30 fps. The page had 4,237 DOM nodes.
- **Why it matters:** each effect is DOM nodes animated with the Web Animations API, plus the `glow` text-shadow and `-webkit-text-stroke` on large glyphs. A phone GPU will be slower than a desktop one.
- **Bounded:** after 6 s the layer was back to 0 nodes, so there is no leak.
- **Cap by device:** 420 is high for a phone. The `calm` mode (cap 160) is a setting, not the phone default.

### 8. Phone: the bead trail is the only record of what you pressed, and it is not tappable (Low-Medium, phone)
- Beads are `aria-hidden` and have no handlers. On a tablet or phone a bead is a natural "play this one again" button.
- Beads are 54px wide with a gap, so at 390 wide about 6 fit. They are drawn at the bottom of the screen, where the home bar and the browser toolbar overlap on iPhone.

### 9. Phone: the settings popover is the only way to change scene, motion or voice (Low-Medium, phone)
- It is 32px icon-sized and generic (`FieldRenderer`, "the same controls as Settings → Config"). The popover was not opened at 390 width, so whether it fits is unverified.

### 10. Both: first-run hint is only A, B, C and gives no instruction (Low, both)
- The "hello" keys A B C show before the first press. They say nothing about "press any key" on desktop or "tap" on phone. A grown-up has no cue either.
- Desktop minor: pressing OS shortcut keys depends on Keyboard Lock, which only works in Chromium fullscreen. In a normal tab, Cmd+W, Cmd+T and F-keys still act on the browser.

## Summary for the phone design
1. Give the phone a real on-screen keyboard, gaps 1 and 8.
2. Hide the grown-up controls and the global action bar behind a deliberate gesture, gap 2.
3. Plan for the platform limits of Lock, safe areas and the audio and speech unlock, gaps 3, 4 and 5.
4. Lower the node cap by device, and add a drag trail, gaps 6 and 7.
