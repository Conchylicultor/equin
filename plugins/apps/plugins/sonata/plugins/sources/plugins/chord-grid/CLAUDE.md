# chord-grid

## Mini-language syntax

The grid is authored in a small mini-language, parsed by
[`web/parse-grid.ts`](web/parse-grid.ts) into timed chord events. Three building
blocks plus two pieces of trivia, nothing else:

| Form | Meaning |
| --- | --- |
| `Cmaj7` | A **chord** — fills one bar. Parsed by `theory`'s `parseChordSymbol` (`F#m`, `Bb13`, `Ebm7b5`, `Eb6/9`, `G7(♯5)`, `Gsus4(♭9)`, …). |
| `vi` | A **degree** — the same, written as a Roman numeral relative to the key. Parsed by `theory`'s `parseRomanNumeral`. |
| `(E E6)` | A **group** — several items share one bar, split equally (`E` for 2 beats, `E6` for 2). |
| `.` | A **hold** — sustains the previous chord instead of striking a new one (no re-strike). |
| `; verse` | A **comment** — the rest of the line is ignored. Contributes no bar. |
| `key: Am` | A **key directive** — sets the key degrees resolve against, from here on. Contributes no bar. |

### Degrees

A cell may name a chord by its **function** rather than its letter: `I vi IV V`
is C Am F G in C major, and F♯m D E in A major — write the progression once,
hear it in any key. The numeral is the exact inverse of the Roman numerals
Sonata already *displays* (`theory`'s `romanNumeral`), so what a chord reads as
is what you can type:

- **Case is the third.** `V` major, `v` minor. `I7` is a dominant seventh, `i7`
  a minor seventh, `Imaj7` a major seventh, `imaj7` a minor-major seventh.
- **Mark, then figure**, both optional: `vii°7`, `iiø7`, `III+`, `IVsus4`, `V9`,
  `I6/9`. ASCII stands in for the glyphs (`o`/`dim` for `°`, `aug` for `+`, `M7`
  for `maj7`). An **explicit mark fixes the third**, so the case then doesn't
  matter — `Idim7` and `IIø7` read the same diminished/half-diminished chord as
  the lowercase `i°7` / `iiø7` convention (lead sheets write both).
- **Alterations & added tones tail the figure**, using the same grammar as
  letter-name chords: `V7♭9`, `V7♯5`, `i7♭5`, `V13♭9`, `I7sus4`, `Iadd9`. ASCII
  `b`/`#` (and parentheses) work: `V7b9` = `V7(♭9)`.
- **A leading `♭`/`♯` chromaticizes the degree**: `♭VII`, `♭VI`, `♯iv°`. ASCII
  `bVII` and `#IV` work too — `#` is only ever a sharp.
- **Degrees are read on the major scale, in every key.** In A minor F is `♭VI`
  (and `VI` is F♯), matching how the numeral is read back — one numeral per
  chord over a tonic, whatever the mode (`music/chord-box`'s `rootReading`).
- **Letter names never consult the key**, so `C ii7 F# V` mixes both freely — no
  numeral begins with a note letter, so the two vocabularies cannot collide.

The key is **C major** unless a `key:` directive says otherwise; `key: Am`,
`key:Am` and `key=Am` are the same thing. A directive mid-grid **modulates**
from that bar onward. A declared key is authored truth: it reaches the `Score` as
`meta.key` (starting key) and `type:"key"` annotations (modulations), so the
notation lens draws the right signature and every chord spells against it
(`♭VII` in F major reads E♭, not D♯). A grid with no directive declares no key —
the analyzer infers one, exactly as before.

**One character does double duty**, disambiguated by what *precedes* it:

- **`(`** at a **cell boundary** opens a bar *group*; a `(` **attached** to a
  chord (no preceding space) is a parenthetical *alteration*, absorbed into the
  chord token. So `G7(♯5)` is one altered chord, `(G7 C)` is a two-chord bar,
  and `(G7(♯5) C)` correctly nests both.

`;` is **not** one of them, and that is the point. The comment marker was once
`#`, disambiguated by position ("a `#` opening a cell is a comment") — which was
safe only because no chord symbol may *begin* with a sharp. Degrees broke that:
`♯IV` legitimately does. Rather than stack a second rule on the first, the marker
moved off the musical alphabet entirely, so `;` starts a comment *anywhere* and
`#` is *always* a sharp. A rule was deleted, not added.

Rules:

- **Each cell is one bar.** Cells are separated by whitespace or newlines;
  newlines are purely cosmetic (lay out bars however reads best). Bar length is
  4 quarter-note beats (4/4).
- **Holds work at both levels.** Inside a group `.` eats one sub-slot
  (`(C . . D)` → C for 3 beats + D for 1); at the top level it eats a whole bar
  (`Cmaj7 . .` → one Cmaj7 sustained across 3 bars). A hold extends whatever
  chord last sounded, even across a bar boundary; a hold with nothing before it
  is silence.
- **Comments are trivia.** A `;` starts one anywhere — it carries no musical
  meaning, so there is no position rule. They are stripped before tokenizing
  (`stripComments`), so a comment can sit anywhere a space can — including inside
  a `( … )` group — without the grammar knowing about it. The terminating newline
  survives, so a comment never glues two lines into one cell. Label sections, park
  an alternative progression, annotate a turnaround.
- **Repetition is just repetition.** To play a chord several times, write it in
  several cells (`Amaj9 Amaj9 Amaj9 Amaj9`). There is no repeat operator.
- **`|` is optional.** A stray `|` between cells is accepted and ignored, so
  older `| C G | Am F |` grids keep parsing.
- **Fail loud.** Unknown chord tokens, a numeral outside the vocabulary, an
  unrecognised key, an unterminated `(`, or a stray `)` are collected into
  `skipped` and surfaced by the loader as a red "Unrecognised" line — never
  silently dropped.

Example:

```
; Verse
Amaj9 Am9 (E E6) (E E6)
Cmaj7 Am7 Dm9 G13

; Chorus — the F#m7 turnaround
Fmaj7 Fm7 Em7 A7
Dm7 G7 Cmaj7      ; ...try Cmaj9 here?
```

The same, as degrees — and a modulation:

```
key: G
I Imaj7 I7 IV
I vi IV V

key: Em      ; relative minor
i iv VI V
```

The parser returns `{ events, skipped, keys }` (`ChordEvent` = `{ data, start,
end }` in quarter-note beats; `keys` = the `{ beat, key }` changes the `key:`
directives establish); the selected voicing strategy from the shared
[`voicing`](../../../voicing/CLAUDE.md) leaf then derives the literal notes.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Chord-grid input source for Sonata. A small mini-language (e.g. `Amaj9 Am9 (E E6)`) authors chord annotations: each cell is a bar, a `( )` group shares a bar, and `.` holds the previous chord. A cell may name a chord by letter (`Am7`) or by degree (`vi7`), the latter resolved against the key a `key:` directive declares. compile() emits chord + key annotations only; the shell's reactive re-voicing step generates the notes under the global voicing config. Persists per-song grid text and contributes the library 'New Chord Grid' affordance, hydration, and an in-player editor section. Owns the sonata_songs_ext_chord_grid side-table: per-song chord text. Creates chord-grid–backed songs and persists grid edits (syncing the parent song's derived duration only; the title is library-owned).
- Web:
  - Contributes:
    - `SonataDocument.Source` "Chord Grid"
    - `Library.Source` "chord-grid"
    - `Sonata.Section` "Chord Grid" → `ChordGridEditorSection`
    - `Sonata.Effect` "chord-grid-persist" → `ChordGridPersistObserver`
  - Uses:
    - `apps/sonata/document.SonataDocument`
    - `apps/sonata/document.useSongDocument`
    - `apps/sonata/library.Library`
    - `apps/sonata/library.openSongImperative`
    - `apps/sonata/shell.Sonata`
    - `apps/sonata/shell.useSonataApp`
    - `infra/endpoints.fetchEndpoint`
    - `infra/endpoints.useEndpointMutation`
    - `primitives/collapsible.FoldMotion`
    - `primitives/collapsible.useCollapsible`
    - `primitives/css/badge.Badge`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/fill.Fill`
    - `primitives/css/spacing.Stack`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/persistent-draft.useDraft`
    - `primitives/syntax-highlight/overlay-textarea.OverlayTextarea`
    - `ui/icons.Icon`
- Server:
  - Uses:
    - `apps/sonata/library._songs`
    - `apps/sonata/library.createSongRow`
    - `apps/sonata/library.updateSongMeta`
    - `infra/endpoints.implement`
    - `infra/entity-extensions.defineExtension`
  - DB schema: `plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/server/internal/tables.ts`
  - Entity extension of: `apps/sonata/library` (table `sonata_songs_ext_chord_grid`)
  - Exports (values): `songChordGrid`
  - Routes:
    - `POST /api/sonata/songs/chord-grid`
    - `GET /api/sonata/songs/:id/chord-grid`
    - `PUT /api/sonata/songs/:id/chord-grid`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --background`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-caption`
    - `ui/tokens/type-scale --font-weight-normal`
    - `ui/tokens/type-scale --line-height-caption`

<!-- AUTOGENERATED:END -->
