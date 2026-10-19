import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { useMemo } from "react";
import {
  collectKeyEntries,
  effectiveKeyAt,
  type Annotation,
  type ChordData,
  type KeySignature,
  type Projection,
  type SectionAnnotation,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  formatChordLabel,
  tonicPc,
} from "@plugins/apps/plugins/sonata/plugins/theory/core";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useChordDisplayMode } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import { chordToneStyle } from "@plugins/music/plugins/chord-box/web";
import { rootReading } from "@plugins/music/plugins/chord-box/core";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import "./chord-overlay.css";

/** A tag's height and its gap above the line its chord starts on, in px. */
const TAG_HEIGHT = 22;
const TAG_LIFT = 2;
/** The section line's height above its tag. */
const SECTION_HEIGHT = 14;

/** One chord tag, resolved once per score / label mode. */
interface Tag {
  annotation: Annotation;
  name: string;
  /** The numeral, or null when the chord has no key (or no numeral). */
  numeral: string | null;
  style: React.CSSProperties;
  /** A section opening on this chord: its name, and the key it moves to. */
  section: { name: string; newKey: KeySignature | null } | null;
}

/**
 * Chord tags along the roll's left edge. Anchored to the time axis only
 * (`requires:["time-axis"]`), so it works on the (vertical) piano roll AND any
 * future time-based display without modification.
 *
 * Each `chord` annotation gets a tag sitting on the line where the chord
 * starts (its Y from the display's published `projection.beatToY`), painted in
 * its numeral's chord colour (`chordToneStyle` — I orange … VII teal, the Chord
 * app's palette): an outlined tag at rest, a filled one while it sounds. The
 * text follows the shared chord-label mode — the name, the numeral or both;
 * the sounding chord always adds its numeral. A section opening on a chord
 * gets one quiet line above its tag, with the key it moves to when it changes
 * key. Rendered inside the display's translated scroll layer, so every tag is
 * drawn once and the lane's clip hides what scrolls offscreen.
 *
 * Re-renders only when the sounding chord changes (`useCursorSelector`),
 * never per playback frame.
 */
export function ChordOverlay({
  projection,
  annotations,
}: {
  projection: Projection;
  annotations: Annotation[];
}) {
  const { score } = useSession();
  const mode = useChordDisplayMode();
  const beatToY = projection.beatToY;

  const tags = useMemo((): Tag[] => {
    const sections = score.annotations.filter(
      (a): a is SectionAnnotation => a.type === "section",
    );
    const keyChanges = collectKeyEntries(score).slice(1);
    return annotations.map((a) => {
      const data = a.data as ChordData;
      const key = effectiveKeyAt(score, a.start) ?? null;
      const roman = formatChordLabel(data, key, "roman");
      const numeral = key !== null && roman !== data.symbol ? roman : null;
      const degree =
        key === null ? null : rootReading(data.root, tonicPc(key.tonic)).degree;
      const opens = sections.find((s) => Math.abs(s.start - a.start) < 1e-6);
      const change = keyChanges.find((k) => Math.abs(k.beat - a.start) < 1e-6);
      return {
        annotation: a,
        name: data.spelledSymbol ?? data.symbol,
        numeral,
        style: chordToneStyle(degree),
        section:
          opens === undefined
            ? null
            : { name: opens.data.name, newKey: change?.key ?? null },
      };
    });
  }, [annotations, score]);

  // The chord sounding at the playhead — the one tag that fills.
  const sounding = useCursorSelector(
    (beat) => annotations.findIndex((a) => beat >= a.start && beat < a.end),
    [annotations],
  );

  if (!beatToY) return null; // defensive: host only mounts us with time-axis.

  return (
    <Pin to="left" stretch decorative layer="float" className="w-40">
      {tags.map((t, i) => {
        const a = t.annotation;
        const data = a.data as ChordData;
        const y = beatToY(a.start);
        const now = i === sounding;
        const showName = mode !== "roman" || t.numeral === null;
        const showNumeral = t.numeral !== null && (mode !== "symbol" || now);
        return (
          <Placed
            key={`${a.start}-${data.symbol}-${i}`}
            x={{ start: 8 }}
            y={{ start: y - TAG_HEIGHT - TAG_LIFT, size: TAG_HEIGHT }}
            className="sonata-chord-tag-host"
            style={t.style}
            title={(() => {
              const name = data.spelledSymbol
                ? `${data.symbol} (${data.spelledSymbol})`
                : data.symbol;
              return a.confidence !== undefined
                ? `${name} · ${(a.confidence * 100).toFixed(0)}% confidence`
                : name;
            })()}
          >
            {t.section !== null ? (
              <span
                className="sonata-chord-tag-section"
                style={{ height: SECTION_HEIGHT }}
              >
                {t.section.name}
                {t.section.newKey !== null ? (
                  <em>→ {keyName(t.section.newKey)}</em>
                ) : null}
              </span>
            ) : null}
            <span className="sonata-chord-tag" data-now={now || undefined}>
              {showName ? <b>{t.name}</b> : null}
              {showNumeral ? <small>{t.numeral}</small> : null}
            </span>
          </Placed>
        );
      })}
    </Pin>
  );
}

/** `G♯ minor` — a key as the section line names the one it moves to. */
function keyName(key: KeySignature): string {
  const tonic =
    key.tonic.slice(0, 1) +
    key.tonic.slice(1).replace(/#/g, "♯").replace(/b/g, "♭");
  return `${tonic} ${key.mode}`;
}
