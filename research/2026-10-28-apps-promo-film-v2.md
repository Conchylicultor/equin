# equin showcase film v2: a continuous session, shown not told

## Context

The storyboard is the "Video" page (`block-7304a68b…`). The script is its agent page **Script v2** (`block-5742f007-c2f6-4f02-9453-42e908c1ca0f`), which is the source of truth for what is on screen and when. v1 (`website/promo-video`, never committed; reference copy in `/tmp/promo-v1-ref/`) was deleted: it told the story with headlines and slogans, cut between unrelated scenes, and used a cliché upbeat track. v2 is one continuous session (Pages → agent manager → files → Sonata → Deploy → Places, evolved in place, Circle created from there, zoomed out to the desktop, then the Mac), with no text except optional captions and the end card, and restrained music with deliberate silences.

Outputs: `~/Downloads/showcase/equin-v0.mp4` and `~/Downloads/showcase/equin-v0-captions.mp4`, 1920×1080, 60 fps, AAC.

## Layout

| Plugin | Owns |
|---|---|
| `media` (new top-level umbrella) | nothing; groups the two below |
| `media/ffmpeg` | `deps/`: a pinned static ffmpeg + ffprobe (macOS arm64), sha256-checked `download` dep |
| `media/film` | `e2e/`: the generic engine. Asset contract (`assets.ts`, written), composition model, in-page renderer, camera, effects, audio mix and SFX synth, render loop, encode |
| `apps/website/promo-film` | `e2e/capture.ts` (layered stills of the real app), `e2e/render.ts` (this film's timeline + scenes over media/film), `deps/` (the music track) |

The e2e-harness keeps v1's one generic addition: `SessionOptions.deviceScaleFactor`.

## Engine design (media/film)

A film is DATA, not a hand-written paint function:

- **Composition** = stage size, duration, assets, a camera and a tree of layers. A layer is an image (a still, optionally cropped by a rect), a sequence (frame chosen from t), a strip, text, a shape (rect/rounded/glow ring/spotlight mask/cursor), or a group. Every layer property (x, y, z, scale, rotateX/Y/Z, opacity, blur, clip-path, crop) is a keyframe track: `[t, value, easing]` with cubic-bezier and spring easings.
- **Camera** = a track of focus point (in a named layer's coordinates), zoom and 3D tilt; motion blur derived from camera velocity, capped.
- **Renderer**: a generic page script that builds the DOM once from the composition and applies `renderAt(t)` (a pure function of t: no CSS transitions, no timers). The render loop sets t, waits two rAFs, screenshots via CDP and pipes to ffmpeg. The film's scenes are TypeScript that BUILDS the composition; nothing scene-specific lives in the page script.
- **Audio**: music bed (a file, section start, gain automation: duck, cut to silence, fade), audio clips (a capture's recorded sound placed at t), and synthesized SFX cues (whoosh, click, key tick, pop, riser, impact, chime, ding, shimmer) rendered in an OfflineAudioContext. Mixed and loudness-normalized in ffmpeg.
- **CLI flags** for any film script: `--preview` (640×360, 30 fps), `--from/--to`, `--stills t1,t2 --stills-out dir`, `--out`, and the film's own variant flags (here `--captions`).

## Capture (promo-film/e2e/capture.ts)

Against main (`--url http://equin.localhost:9000`, read-only: staging is DOM injection and UI-only interaction, never a write). Viewport 1280×720, DPR 2. Every shot is a full-frame still plus the rects of every element a scene animates, so the composition can lift panes, icons and popovers out of a still as separate layers. Fails loudly when an asset or rect is missing. The shot list is in the capture brief and follows the script section by section.

## Execution

1. In parallel:
   - **Music** (Sonnet): find, license-check and declare the track; report BPM, structure, and where the three silences can fall.
   - **Engine** (Opus): `media/ffmpeg` + `media/film`, verified by a small test film.
   - **Capture** (Sonnet): `capture.ts` and the asset set.
2. Me: the timeline and scenes in `promo-film/e2e/render.ts`, cut to the track; preview renders; frame review.
3. Full renders of both variants into `~/Downloads/showcase/`.

## Verification

- `capture.ts` writes every asset in its shot list with every rect present.
- `render.ts --preview` and `--stills` at each section boundary, reviewed as PNGs.
- `ffprobe` on the outputs: 1920×1080, 60 fps, AAC stereo, about 64 s.
- `./equin check boundary-rules plugin-boundaries type-check`.

## User feedback on v0 (2026-10-29) — standing preferences

Recorded verbatim in spirit; future passes tune to these. To be mirrored on the Script v2 page.

**Principle: one continuous, real session.** The film must read as someone actually using equin — real UI transitions driven by real clicks, not stage transitions between stills. Invented cross-fades, fake zoom+slide pane expansions and reflow double-images break immersion. Scripted motion is fine for the *camera* (zoom to focus) and for driving inputs (cursor, typing, a slider sweep), never for the app's own UI.

- **Intro:** far too long — ~10 s on a static gallery with odd icon effects. Cut hard.
- **Integrated:** one session, not many short segments.
  - Opening the conversation from the chip must look like a real click opening the pane.
  - A new pane opens at 50% width beside the page (v0 squeezed it into the right edge).
  - Expanding a pane happens through its real Expand button, not a fake zoom+slide.
  - Files: the conversation opens a file *preview*; Expand on the preview opens the same file in the file explorer (main 23fb49165f: file-preview Expand → Files).
  - Files → MIDI file → Sonata: continuous, real navigation; clicking "Sonata" opens the app as the app really opens.
- **Other apps montage (Places/Deploy/…):** must clearly read as a quick tour of other apps — v0 showed Deploy for half a frame, blurred, unreadable. Each app legible. Add Chord.
- **Evolving:** zoom in on the "Pick UI element" button when it's used, and on the Wish prompt field while typing.
- **Typing:** smooth per-character typing like a promo video (not words popping in).
- **Create / prototype:** show the real transitions — visible clicks on mobile, on side-by-side. The slider UI must be the app's real one (its sweep may be scripted, the UI truthful).
- **Sound:** SFX much more subtle; no whoosh on every transition (feels cheap).
- **Music:** try a different track. Never stop the music to let Sonata's piano be heard — keep it running (duck at most).
