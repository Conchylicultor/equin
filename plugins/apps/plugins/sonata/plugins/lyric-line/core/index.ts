/**
 * `@plugins/apps/plugins/sonata/plugins/lyric-line/core` — the score's songsheet
 * lines and the chord sounding over them, pure and framework-free.
 */

export type {
  ActiveChord,
  LyricChordReading,
  LyricLineGroup,
  LyricPosition,
} from "./lyric-lines";
export {
  activeLyricChord,
  currentLyricLine,
  groupLyricLines,
  lyricChordReadings,
  lyricLines,
  lyricPosition,
  sameActiveChord,
  sameLyricPosition,
} from "./lyric-lines";
