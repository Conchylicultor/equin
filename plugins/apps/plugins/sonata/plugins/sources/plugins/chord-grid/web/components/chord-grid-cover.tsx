import { ChordBox, ChordNumeral } from "@plugins/music/plugins/chord-box/web";
import type { CoverChord } from "../internal/cover-chords";
import "../chord-grid.css";

/**
 * A chord-grid song's cover: its first chords as a 3 × 2 grid of filled
 * chord boxes (`music/chord-box`), each painted in its degree's themable
 * `--chord-N` colour, the chord's name large at the bottom-left and its
 * numeral small at the top-right. Fills the cover frame it is drawn in (the
 * frame owns the aspect). A picture, not a control: the boxes carry no hit
 * button, and the whole grid reads as one image naming its chords.
 */
export function ChordGridCover({ chords }: { chords: readonly CoverChord[] }) {
  return (
    <div
      className="chord-grid-cover"
      role="img"
      aria-label={`Chords: ${chords.map((c) => c.root + c.suffix).join(", ")}`}
    >
      {chords.map((chord, i) => (
        <ChordBox
          // A cover is redrawn whole; a tile's place is its identity.
          key={i}
          degree={chord.degree}
          state="filled"
          className="chord-grid-cover-tile"
          adornment={
            <ChordNumeral
              numeral={chord.numeral}
              mark=""
              className="chord-grid-cover-numeral"
            />
          }
        >
          <span className="chord-box-symbol chord-grid-cover-name">
            {chord.root}
            {chord.suffix !== "" && (
              <span className="chord-box-symbol-mark">{chord.suffix}</span>
            )}
          </span>
        </ChordBox>
      ))}
    </div>
  );
}
