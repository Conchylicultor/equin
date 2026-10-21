import { SUBMIT_TOOL } from "../../core";
import { inputFilePath, type ProfileInput } from "./profile-input";

/**
 * The transcribing agent's CLAUDE.md — its whole project context. Code, not
 * data on the row, so an improvement reaches the next launch.
 */
export function transcriptionInstructions(input: ProfileInput): string {
  return [INTRO, sourceSection(input.source), TOOLS, STEPS, CONVENTIONS].join(
    "\n\n",
  );
}

const INTRO = `# Transcribe sheet music to MusicXML

Turn the engraved sheet music in your source into one MusicXML file that the
Sonata app will play and engrave. You work alone in this directory; everything
you need is here. Accuracy beats speed: a wrong note is worse than a slow
transcription. Transcribe what is printed — never invent music that is not
in the source.`;

/** One line per input file: where it is, and how to read it. */
function fileLines(files: readonly { name: string }[]): string {
  return files
    .map((f, i) => {
      const path = inputFilePath(i, f.name);
      if (!/\.pdf$/i.test(path))
        return `- \`${path}\` — an image: one page, read it directly`;
      const out = `frames/${String(i + 1).padStart(2, "0")}`;
      return `- \`${path}\` — a PDF: \`./bin/st pages ${path} --out ${out}\`, then read \`${out}/NN.png\``;
    })
    .join("\n");
}

function sourceSection(source: ProfileInput["source"]): string {
  if (source.kind === "prompt") {
    const files =
      source.files.length > 0
        ? `\n\nThe files attached to it are copied here, in the order given:\n\n${fileLines(source.files)}`
        : "";
    return `## Your source

The user's message says what to transcribe, and may add instructions (which
pages, which part, a title) — follow them. A link to a video or post: fetch it,
then extract the score frames:

    ./bin/st fetch '<url>' --out input
    ./bin/st frames input/video.mp4 --out frames

\`input/meta.json\` holds the post's title and caption (often the song's name,
tempo and style).${files}`;
  }
  if (source.kind === "url") {
    return `## Your source

A video or post: ${source.url}

Fetch it, then extract the score frames:

    ./bin/st fetch '${source.url}' --out input
    ./bin/st frames input/video.mp4 --out frames

\`input/meta.json\` holds the post's title and caption (often the song's name,
tempo and style).`;
  }
  return `## Your source

Uploaded files, in this order:

${fileLines(source.files)}`;
}

const TOOLS = `## Tools

\`./bin/st\`, run from this directory. Each command prints what it wrote; on
failure it prints one \`st: <reason>\` line and exits 1.

- \`./bin/st fetch <url> --out input\` — \`input/video.mp4\` + \`input/meta.json\`.
  On "login required", rerun with \`--cookies-from-browser chrome\`.
- \`./bin/st frames input/video.mp4 --out frames\` — \`frames/01.png\`, \`02.png\`, …:
  a crop of the sheet-music band each time it changes, in video order, plus
  \`frames/thumbnail.png\` (one whole frame). Read the thumbnail first: if the
  crop misses part of the score or includes the player, rerun with
  \`--region x,y,w,h\` (pixels of the whole frame). Near-duplicate crops: raise
  \`--threshold\` (default 14); a page missing: lower it.
- \`./bin/st pages <file.pdf> --out frames\` — one \`frames/NN.png\` per page
  (\`--scale 3\` for small print).
- \`./bin/st render score.musicxml --out render\` — your score engraved:
  \`render/01.png\`, … (rerun after every edit; it replaces the pages).
- \`./bin/st side-by-side <source.png> <render.png> --out compare/NN.png\` — the
  source stacked over your render, for comparing.`;

const STEPS = `## Steps

1. **Read every page.** Read each source image (frames or uploaded images) in
   order. Note the title, composer, tempo and style marks ("Swung 16ths",
   ♩=110), key and time signatures, the instrument(s), and the bar count.
2. **Order the pages.** Frames from a video are consecutive views of ONE
   score. A scrolling or page-turning video repeats systems across frames:
   concatenate the music in order and include every bar exactly once — before
   appending a frame, match its first bars against the end of what you have
   (printed bar numbers help). The same holds for overlapping photos.
3. **Draft \`score.musicxml\`** (conventions below), the whole piece.
4. **Check, bar by bar, until nothing differs:**
   1. \`./bin/st render score.musicxml --out render\`
   2. For each source page (frame, image or PDF page), \`./bin/st side-by-side
      <source page> render/MM.png --out compare/NN.png\` (MM: the render page
      holding the same bars), and Read the result.
   3. Compare every bar of every staff: pitches (count ledger lines and
      spaces), accidentals (key signature, naturals, accidentals carried
      through the bar), rhythms (beams, flags, dots, tuplets), rests, ties,
      chord symbols (quality, extensions, slash bass), clefs, key/time
      changes, tempo and swing.
   4. Fix every difference in \`score.musicxml\` and go back to 1. Stop only
      after a full pass that finds no difference.
5. **Submit**: call \`${SUBMIT_TOOL}\` with \`path: "score.musicxml"\`. A parse
   error names the element and measure: fix it, render again, resubmit.
6. **Finish**: once the submit succeeds, write two lines — what you
   transcribed, and any bar you were unsure of — then end your turn. Never
   call \`exit_clean\`: the user reads your run in Sonata and may reply.

Only when you are truly blocked — the source cannot be fetched even with
cookies, or holds no readable sheet music — call \`flag_raise\` with the reason
and stop. Never submit a guess.

## When the user replies

A reply points at a mistake in the submitted score ("bar 12 is wrong", "the
left hand is an octave low"). Re-read that part of the source, fix
\`score.musicxml\`, render it and compare it side by side with the source
again (step 4, for the bars concerned and their neighbours), then submit again
— it replaces the song's score — and end your turn with one line on what you
changed. If the reply is a question, answer it and end your turn.`;

const CONVENTIONS = `## MusicXML conventions

- MusicXML 4.0 \`<score-partwise version="4.0">\`.
- Title: \`<work><work-title>\` — the heading printed on the score, else a short
  title from \`input/meta.json\` (the song, not the whole caption). Composer:
  \`<identification><creator type="composer">\` when printed.
- **Piano is ONE part with two staves**: \`<staves>2</staves>\`, \`<clef number="1">\`
  (G, line 2) and \`<clef number="2">\` (F, line 4), and a \`<staff>\` on every note.
  Other instruments: one part each.
- \`<divisions>\` per quarter: a value every duration divides into (4 for 16ths,
  12 if triplets appear). \`<duration>\` is what plays; \`<type>\`, \`<dot/>\` and
  \`<time-modification>\` are how it looks — write both.
- **Every voice fills its bar exactly** (durations sum to the time signature).
  Write staff 1 (voice 1), then \`<backup><duration>\` one whole bar, then
  staff 2 (voice 5). A second voice in a staff: another \`<backup>\` and voice 2
  (staff 1) or 6 (staff 2); fill its silent stretches with rests or \`<forward>\`.
- Chords: every note after the first carries \`<chord/>\` and the same duration.
- Pitch: \`<alter>\` always states the sounding pitch (also when the key
  signature implies it); \`<accidental>\` is the printed sign.
- Ties: \`<tie type="start"/>\` + \`<notations><tied type="start"/></notations>\` on the
  first note, \`stop\` on the second (both elements). A slur is not a tie.
- Rests: \`<note><rest/><duration>…</duration><voice>…</voice><staff>…</staff></note>\`; a
  whole-bar rest is \`<rest measure="yes"/>\` lasting the whole bar.
- **Chord symbols**: \`<harmony>\` right before the note where the chord starts
  (or with \`<offset>\` in divisions), e.g.
  \`<harmony><root><root-step>D</root-step></root><kind text="m9">minor-ninth</kind></harmony>\`.
  Flat/sharp root: \`<root-alter>-1</root-alter>\`. **Slash chords** (C/E): add
  \`<bass><bass-step>E</bass-step></bass>\`. Use the standard \`<kind>\` values
  (major, minor, dominant, major-seventh, minor-seventh, dominant-ninth,
  major-ninth, minor-ninth, suspended-fourth, diminished, half-diminished,
  augmented, …) and \`<degree>\` for added or altered tones.
- **Tempo** as printed, in measure 1:
  \`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>110</per-minute></metronome></direction-type><sound tempo="110"/></direction>\`.
- **Swing** when marked ("Swing", "Swung 16ths", ♫ = ♪³♪): a direction in
  measure 1 with \`<sound><swing><first>2</first><second>1</second><swing-type>16th</swing-type></swing></sound>\`
  (\`eighth\` for swung 8ths). Notate the rhythm straight, as printed.
- Repeats: \`<barline><repeat direction="forward"/></barline>\` / \`"backward"\`;
  first/second endings with \`<ending number="1" type="start">\` … \`"stop"\` (or
  \`"discontinue"\`). D.C., D.S. and coda jumps are rejected: write those
  passages out in full instead.
- A pickup bar: \`<measure number="0" implicit="yes">\` with only its notes.
- Leave out fingerings, pedal marks, lyrics and layout; dynamics are optional.`;
