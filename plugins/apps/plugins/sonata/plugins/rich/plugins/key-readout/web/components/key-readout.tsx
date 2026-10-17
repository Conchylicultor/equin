import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useMemo } from "react";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import type {
  KeyRenderState,
  LabelTone,
} from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/keyboard/web";
import {
  ChordKeyboardRow,
  ChordRowFrame,
  ReadoutKeyboard,
  useReadoutPlane,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/readout-keyboard/web";
import {
  chordBoxFace,
  useChordDisplayMode,
} from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import {
  accidentalGlyph,
  collectKeyEntries,
  makeKeySpeller,
  type Annotation,
  type ChordData,
  type KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  chordVoicing,
  diatonicChords,
  tonicPc,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";

/** The active key plus where it came from, for the source badge. */
type ActiveKey = { key: KeySignature; source: "authored" | "derived" };

function sameActiveKey(
  a: ActiveKey | undefined,
  b: ActiveKey | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.key.tonic === b.key.tonic &&
    a.key.mode === b.key.mode &&
    a.source === b.source
  );
}

/** Nothing is lit on the scale keyboard — the scale is drawn as dots. */
const NO_KEYS: readonly number[] = [];
/** No voicings while no key is in force — a stable identity for the fit. */
const NO_VOICINGS: readonly (readonly number[])[] = [];

/**
 * The muted dot a non-tonic scale degree wears, by the surface it sits on. A
 * piano is a physical object, so these stay fixed across light/dark themes
 * (the same reasoning as the piano keyboard's labels); the chrome's `tone` says
 * whether the pad reads light or dark, so no skin is named here.
 */
const DEGREE_DOT: Record<LabelTone, string> = {
  "on-light": "#71717a",
  "on-dark": "#a1a1aa",
};

/** A scale-degree dot on a key: the tonic larger and in the theme accent. */
function ScaleDot({ tonic, tone }: { tonic: boolean; tone: LabelTone }) {
  const size = tonic ? 7 : 5;
  return (
    <span
      className="block"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: tonic ? "var(--primary)" : DEGREE_DOT[tone],
      }}
    />
  );
}

/**
 * The "current key" readout — the BODY of a `Sonata.Section` whose chrome (the
 * collapsible "Current key" header) the host paints. Reads the session's Score +
 * cursor (`useSession()`) and shows the key in force at the playhead (the song's
 * `meta.key` plus mid-song `key` annotations), tracking it through key changes.
 *
 * - The key's name, big; under it, visible rather than in a tooltip, its
 *   relative key and where the key came from (the source badge).
 * - A two-octave readout keyboard with a dot on every scale degree — the tonic
 *   in the accent — and the scale's note names as chips beneath it. It is drawn
 *   on the diatonic chords' plane, in the chord rows' frame (`ChordRowFrame`),
 *   so it lines up key-for-key with the chord rows below.
 * - A "Chords" toggle stacks the key's seven diatonic chords below, each the
 *   chord list's own row (`ChordKeyboardRow`: its chord box under the chord-label
 *   mode, a readout keyboard lit with its notes in its colour, and how many
 *   times the song plays a chord on its root — blank when it never does);
 *   clicking one sounds it, and the row whose root is the chord under the
 *   playhead is marked.
 *
 * Always available (a key can be established without chords), so the section has
 * no `useAvailable` gate; the keyless case stays an in-body "No key detected."
 * (a loading state while the song's settings load). The per-song "Auto-detect"
 * toggle lives in the contribution's `actions` (see `KeyReadoutActions`) so it
 * stays reachable while the section is collapsed.
 */
export function KeyReadout() {
  const { score } = useSession();
  const { content } = useSongDocument();
  const mode = useChordDisplayMode();
  const scorePending = content.kind === "pending";
  const scoreFailure = content.kind === "failed" ? content.failure : null;
  const [showChords, setShowChords] = useDraft<boolean>(
    "sonata:key-readout:chords",
    true,
  );

  // Beat-indexed key entries — recomputed only when the Score changes. Walking
  // the memoized list (rather than `effectiveKeyAt`, which rebuilds it each call)
  // yields STABLE `key` references, so `useCursorSelector` re-renders this panel
  // only when the key changes — not on every cursor frame.
  const entries = useMemo(() => collectKeyEntries(score), [score]);

  // The active entry (key + source) at the playhead, with the same cursor-at-0
  // fallback the key chip uses so the panel is never blank on load. The selector
  // mints a fresh object each call, so pass a value-comparing `isEqual` to keep
  // the per-frame re-render bailout.
  const active = useCursorSelector<ActiveKey | undefined>(
    (cursorBeat) => {
      let found: ActiveKey | undefined;
      for (const e of entries) {
        if (e.beat <= cursorBeat) found = { key: e.key, source: e.source };
        else break; // entries are ascending — no later one can apply.
      }
      if (found) return found;
      const first = entries[0];
      return first ? { key: first.key, source: first.source } : undefined;
    },
    [entries],
    sameActiveKey,
  );
  const current = active?.key;

  const chords = useMemo(
    () =>
      score.annotations.filter(
        (a): a is Annotation<"chord", ChordData> => a.type === "chord",
      ),
    [score.annotations],
  );

  // How many times the song strikes a chord on each root pitch class — the
  // count a diatonic chord's row shows (matched by root, as the playhead mark is).
  const usesByRoot = useMemo(() => {
    const uses = new Map<number, number>();
    for (const c of chords) {
      const pc = ((c.data.root % 12) + 12) % 12;
      uses.set(pc, (uses.get(pc) ?? 0) + 1);
    }
    return uses;
  }, [chords]);

  // The root pitch class of the chord under the playhead — a number, so the
  // panel re-renders only when the chord's root changes, not every frame.
  const currentRoot = useCursorSelector(
    (cursorBeat) => {
      const c =
        chords.find((a) => cursorBeat >= a.start && cursorBeat < a.end) ??
        (cursorBeat <= 0 ? chords[0] : undefined);
      return c ? ((c.data.root % 12) + 12) % 12 : undefined;
    },
    [chords],
  );

  const scale = useMemo(() => {
    if (!current) return null;
    const speller = makeKeySpeller(current);
    const root = tonicPc(current.tonic);

    // Diatonic pitch classes, ordered from the tonic up. `diatonic` returns null
    // for any pc outside the key, so it doubles as scale membership.
    const ordered: { pc: number; name: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const pc = (root + i) % 12;
      if (!speller.diatonic(pc)) continue;
      const sp = speller.spell(pc + 60); // octave is irrelevant to step/alter
      ordered.push({ pc, name: sp.step + accidentalGlyph(sp.alter) });
    }

    // Relative key (shares the same notes): +3 semitones from a minor tonic to
    // its relative major, +9 from a major tonic to its relative minor.
    const relPc = (root + (current.mode === "major" ? 9 : 3)) % 12;
    const relSp = speller.spell(relPc + 60);
    const relative = {
      tonic: relSp.step + accidentalGlyph(relSp.alter),
      mode: current.mode === "major" ? "minor" : "major",
    };

    return {
      root,
      degrees: ordered,
      inScale: new Set(ordered.map((d) => d.pc)),
      relative,
    };
  }, [current]);

  // The key's seven diatonic chords, each voiced as written, all fitted onto
  // ONE readout plane so every row has the same two-octave shape. The scale
  // keyboard is drawn on this plane too: a scale is a pitch-class set, so its
  // dots repeat in every octave and fit any window.
  const diatonic = useMemo(
    () =>
      current
        ? diatonicChords(current).map((d) => ({
            ...d,
            face: chordBoxFace(d.chord, current, mode),
          }))
        : [],
    [current, mode],
  );
  const voicings = useMemo(
    () =>
      diatonic.length === 0
        ? NO_VOICINGS
        : diatonic.map((d) => chordVoicing(d.chord)),
    [diatonic],
  );
  const chordPlane = useReadoutPlane(voicings);

  // The song's settings are still loading (the score is withheld until they
  // settle): not "No key detected".
  if (scoreFailure !== null)
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the song's settings"
        error={scoreFailure.error}
        refetch={scoreFailure.refetch}
      />
    );
  if (scorePending) return <Loading variant="rows" count={2} />;

  if (!current || !scale)
    return (
      <Text as="div" variant="body" tone="muted">
        No key detected.
      </Text>
    );

  const renderScaleDot = (key: { pitch: number }, state: KeyRenderState) => {
    const pc = ((key.pitch % 12) + 12) % 12;
    if (!scale.inScale.has(pc)) return null;
    return <ScaleDot tonic={pc === scale.root} tone={state.tone} />;
  };

  return (
    <Stack gap="md">
      {/* Name row: the key and what it is, with the Chords toggle trailing. */}
      <Stack direction="row" align="start" justify="between" gap="sm">
        <Stack gap="2xs">
          <Text as="div" variant="title">
            {current.tonic} {current.mode}
          </Text>
          <Cluster gap="xs">
            <Text variant="caption" tone="muted">
              relative {scale.relative.tonic} {scale.relative.mode}
            </Text>
            <Badge>
              {active?.source === "derived" ? "Auto-detected" : "From the song"}
            </Badge>
          </Cluster>
        </Stack>
        <ToggleChip
          active={showChords}
          onClick={() => setShowChords((v) => !v)}
          tooltip="Show the chord built on each degree of the scale"
        >
          Chords
        </ToggleChip>
      </Stack>

      {/* The scale: dots on every octave, then its note names, tonic first. */}
      <Stack gap="sm">
        <ChordRowFrame>
          <ReadoutKeyboard
            plane={chordPlane.plane}
            lit={NO_KEYS}
            renderKey={renderScaleDot}
          />
        </ChordRowFrame>
        <Cluster gap="xs">
          {scale.degrees.map((d) => (
            <Badge
              key={d.pc}
              variant={d.pc === scale.root ? "primary" : "muted"}
            >
              {d.name}
            </Badge>
          ))}
        </Cluster>
      </Stack>

      {showChords && (
        <Stack gap="2xs">
          {diatonic.map((d, k) => {
            const uses = usesByRoot.get(d.chord.root) ?? 0;
            return (
              <ChordKeyboardRow
                key={d.degree}
                degree={d.face.degree}
                label={d.face.label}
                name={`${d.face.name}, played ${String(uses)} times`}
                plane={chordPlane.plane}
                notes={chordPlane.voicings[k] ?? NO_KEYS}
                now={currentRoot === d.chord.root}
                trail={uses > 0 ? `×${String(uses)}` : undefined}
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
