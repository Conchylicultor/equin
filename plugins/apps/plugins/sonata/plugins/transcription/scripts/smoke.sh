#!/bin/sh
# Manual check of the `st` toolkit: needs `./singularity deps install sonata-transcription`.
# Usage: scripts/smoke.sh <out-dir>   (ST_PYTHON defaults to the installed env)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: smoke.sh <out-dir>}
st="$here/../bin/st"
mkdir -p "$out"
cat > "$out/score.musicxml" <<'X'
<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>
X
"$st" render "$out/score.musicxml" --out "$out/render"
"$st" side-by-side "$out/render/01.png" "$out/render/01.png" --out "$out/sbs.png"
echo "smoke ok: $out"
