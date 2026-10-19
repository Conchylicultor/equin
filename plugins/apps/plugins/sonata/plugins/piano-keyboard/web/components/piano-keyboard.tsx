import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEffect, useMemo, useState } from "react";
import {
  accidentalGlyph,
  buildActiveNoteIndex,
  effectiveKeyAt,
  isAccidental,
  makeKeySpeller,
  type KeySpeller,
  type PitchKey,
  type Projection,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  Keyboard,
  type LabelTone,
  useSonataKeySkin,
} from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/keyboard/web";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { usePerformedScore } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/swing/web";
import { useLivePlay } from "@plugins/apps/plugins/sonata/plugins/audio/plugins/live-play/web";
import {
  useTrackColorLook,
  useHiddenTrackIds,
  useMutedTrackIds,
  useTrackColorMap,
} from "@plugins/apps/plugins/sonata/plugins/track-mixer/web";
import { useConfig } from "@plugins/config_v2/web";
import { pianoKeyboardConfig } from "../../shared/config";

/**
 * `whites-plus-in-key` is the PERSISTED value, and the spelling lags the label
 * on purpose: `enumField` builds its `z.enum` from these values and config_v2
 * has no migration, so renaming it would silently drop every user's setting. The
 * label reads "Naturals + in-key accidentals" (see `shared/config.ts`).
 */
type LabelScope = "diatonic" | "whites-plus-in-key" | "all";

/**
 * Resting label text colors, keyed by the TONE the keyboard reports — which
 * surface the label sits on, not which kind of key it is. The key chrome is
 * owned by the shared keyboard primitive and differs per layout, so the chrome
 * is the one that knows whether a pad reads light or dark. A piano is a physical
 * object, so these stay fixed across light/dark themes; inline styles keep them
 * out of the className-only `no-hardcoded-colors` check.
 */
const LABEL_COLOR: Record<LabelTone, string> = {
  "on-light": "#52525b",
  "on-dark": "#d4d4d4",
};

/** White pitch-class → natural letter (for keys outside the key signature). */
const NATURAL_LETTER: Record<number, string> = {
  0: "C",
  2: "D",
  4: "E",
  5: "F",
  7: "G",
  9: "A",
  11: "B",
};

/** Scientific octave: MIDI 60 = C4. */
function octaveOf(pitch: number): number {
  return Math.floor(pitch / 12) - 1;
}

/**
 * Value-equality for the lit map (pitch → CSS color). The cursor selector builds
 * a fresh Map every frame, so the default `Object.is` would never match and the
 * keyboard would re-render on every tick. Comparing by content lets the bailout
 * fire whenever the sounding set is unchanged — the common case between note
 * boundaries.
 */
function sameLitMap(a: Map<number, string>, b: Map<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [pitch, color] of a) {
    if (b.get(pitch) !== color) return false;
  }
  return true;
}

/**
 * The label for one key under the active scope, spelled for the key signature.
 * Returns null when this key should stay blank. The octave number is appended
 * only on a natural C, matching the prior keyboard's orientation markers.
 */
function keyLabel(
  k: PitchKey,
  speller: KeySpeller,
  scope: LabelScope,
): string | null {
  const render = (s: { step: string; alter: number }): string => {
    const base = `${s.step}${accidentalGlyph(s.alter)}`;
    return s.step === "C" && s.alter === 0
      ? `${base}${octaveOf(k.pitch)}`
      : base;
  };

  const dia = speller.diatonic(k.pitch);
  if (scope === "diatonic") return dia ? render(dia) : null;
  if (scope === "whites-plus-in-key") {
    if (isAccidental(k.pitch)) return dia ? render(dia) : null;
    const pc = ((k.pitch % 12) + 12) % 12;
    return render(dia ?? { step: NATURAL_LETTER[pc] ?? "", alter: 0 });
  }
  return render(speller.spell(k.pitch)); // "all"
}

/**
 * The keyboard in the roll's pitch-axis gutter. Draws `projection.pitchPlane` —
 * the very pads the falling notes were laid on — through the shared keyboard
 * primitive, so each note column lands exactly on its key and this component
 * derives no range and lays out nothing. Key labels follow the score's key signature (`score.meta.key`) —
 * configurable via the plugin's `labelScope` — and keys sounding at the playback
 * cursor light up in their per-track color, connecting the falling notes to the
 * keys they land on.
 */
export function PianoKeyboard({ projection }: { projection: Projection }) {
  // Sonata's own look paints its keys: one control, every keyboard in the app.
  const skin = useSonataKeySkin();
  const trackColors = useTrackColorLook();
  const plane = projection.pitchPlane;
  const { score } = useSession();
  const { labelScope } = useConfig(pianoKeyboardConfig);

  const speller = useMemo(
    () => makeKeySpeller(effectiveKeyAt(score, 0)),
    [score],
  );

  // Per-track view-state, shared with the falling notes (color + hidden) and the
  // audio engine (muted). Memo-stable across frames, so reading it inside the
  // per-frame `sounding` selector below is free. Until the song's track views
  // are known no key lights for playback (the score is withheld then too).
  const colorMap = useTrackColorMap();
  const hiddenIds = useHiddenTrackIds();
  const mutedIds = useMutedTrackIds();

  // "What's sounding at beat t" as a precomputed stabbing index, rebuilt only
  // when the note set changes — NOT per frame. Querying it is O(local
  // polyphony), so the per-frame work no longer scales with the score size (a
  // dense 22-track score has thousands of notes but only a handful sounding at
  // once).
  //
  // Built from the notes as performed (swung like the audio, unless turned off
  // in Feel), so a key lights when its note sounds and the falling bar lands.
  const performed = usePerformedScore(score);
  const noteIndex = useMemo(
    () => buildActiveNoteIndex(performed.notes),
    [performed.notes],
  );

  // Pitches sounding at the cursor → the color to light each with. A key lights
  // only for notes on a track that is neither hidden (gone from the roll) nor
  // muted (silent), so the keyboard tracks the same view-state as the falling
  // notes and the audio. The first eligible note per pitch picks the tint — the
  // index preserves `score.notes` order, so the winner matches the old full-
  // array scan. This is exactly the keyboard primitive's map-form `lit`: pitch →
  // CSS color ("" → theme accent).
  //
  // Driven by `useCursorSelector` with a value-equality bailout: the selector
  // runs every frame (cheaply), but the component re-renders ONLY when the lit
  // set actually changes — i.e. when a note crosses an on/off boundary — instead
  // of reconciling and minting a fresh Map identity on every rAF tick.
  const sounding = useCursorSelector(
    (beat, position) => {
      const m = new Map<number, string>();
      // Inside an A–B loop's rest nothing sounds: `beat` is the A about to play.
      if (position.rest > 0) return m;
      // Unsettled (pending or failed) track views light nothing: the score is
      // empty then too, and the player's score gate says why.
      if (
        colorMap.kind !== "settled" ||
        hiddenIds.kind !== "settled" ||
        mutedIds.kind !== "settled"
      )
        return m;
      const colors = colorMap.value;
      const hidden = hiddenIds.value;
      const muted = mutedIds.value;
      for (const n of noteIndex.at(beat)) {
        if (hidden.has(n.track) || muted.has(n.track)) continue;
        if (!m.has(n.pitch)) m.set(n.pitch, colors.get(n.track) ?? "");
      }
      return m;
    },
    [noteIndex, colorMap, hiddenIds, mutedIds],
    sameLitMap,
  );

  // Hand-play: when the live player is available the keyboard becomes
  // interactive. `held` is the set of pitches currently pressed by the user;
  // null `live` (no engine) simply leaves the keyboard non-playable.
  const live = useLivePlay();
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    live?.warmup();
    return () => live?.releaseAll();
  }, [live]);

  const interaction = useMemo(
    () =>
      live
        ? {
            onPress: (p: number) => {
              live.press(p);
              setHeld((s) => {
                const n = new Set(s);
                n.add(p);
                return n;
              });
            },
            onRelease: (p: number) => {
              live.release(p);
              setHeld((s) => {
                const n = new Set(s);
                n.delete(p);
                return n;
              });
            },
          }
        : undefined,
    [live],
  );

  // Merge hand-held pitches into the playback `sounding` map: a held key that
  // isn't already sounding lights in the theme accent ("" → accent); a key that
  // is both keeps its playback color. So a hand-pressed key depresses + glows
  // exactly like a played note via the primitive's existing lit→press visuals.
  const lit = useMemo(() => {
    if (held.size === 0) return sounding;
    const m = new Map(sounding);
    for (const p of held) if (!m.has(p)) m.set(p, "");
    return m;
  }, [sounding, held]);

  if (!plane) return null; // defensive: host only mounts us with pitch-plane.

  const scope = labelScope as LabelScope;

  return (
    <Keyboard
      plane={plane}
      lit={lit}
      skin={skin}
      interaction={interaction}
      // The pitch-axis gutter sizes the keybed (the layout's keybed height);
      // the keys stretch to it so they stay under the falling notes.
      sizing="fill"
      // A lit accidental shows the same shade as the falling note that lands
      // on it — the look's own accidental colour, as the piano-roll uses.
      accidentalColor={trackColors.accidental}
      // The keyboard primitive owns the element, so the layer arrives as the
      // class helper: a full-bleed fill of the pitch-axis gutter, inside which
      // the primitive lays its keys by runtime projection coordinates.
      className={cn(layerClasses(), "rounded-none bg-muted/30")}
      renderKey={(k, { lit, tone, narrow }) => {
        const text = keyLabel(k, speller, scope);
        if (!text) return null;
        return (
          <span
            // eslint-disable-next-line text/no-adhoc-typography, type-scale-tokens/no-arbitrary-font-size -- 9px/7px labels tuned to fit a narrow key cap; below the 10px token floor, tight leading centers them on the key
            className={`select-none leading-none ${narrow ? "text-[7px]" : "text-[9px]"} ${lit ? "text-primary-foreground" : ""}`}
            style={lit ? undefined : { color: LABEL_COLOR[tone] }}
          >
            {text}
          </span>
        );
      }}
    />
  );
}
