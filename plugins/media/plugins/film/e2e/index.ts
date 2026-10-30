// media/film: a film is a Composition (data) built by a film script; the
// engine renders it frame by frame in a headless page and encodes it with its
// mixed sound. See the plugin's CLAUDE.md for the model.
export type {
  AssetManifest,
  AudioClip,
  InputLog,
  Rect,
  Sequence,
  Still,
  Strip,
} from "./internal/assets";
export type {
  Camera,
  Composition,
  FilmAudio,
  GroupLayer,
  HtmlLayer,
  ImageLayer,
  Layer,
  LayerBase,
  MotionBlur,
  MusicBed,
  PlacedClip,
  RectV,
  SequenceLayer,
  Shape,
  ShapeLayer,
  StripLayer,
  TextLayer,
  TextReveal,
  TextRun,
  Vec2,
  Vec3,
  Vec4,
} from "./internal/composition";
export type { SfxCue, SfxKind } from "./internal/cues";
export type { Easing, EasingName } from "./internal/easing";
export type { Key, Track, Value } from "./internal/tracks";
export type { FilmContext, FilmScript } from "./internal/run";
export { ease } from "./internal/easing";
export { sample, shiftTrack } from "./internal/tracks";
export { cuesInRange } from "./internal/cues";
export { loadManifest } from "./internal/manifest";
export {
  center,
  checkComposition,
  cropLift,
  fade,
  frameOn,
  group,
  html,
  image,
  inflate,
  rectOf,
  rectV,
  recordedCursor,
  recordedSfx,
  ring,
  sequence,
  shape,
  strip,
  text,
  typing,
} from "./internal/builders";
export { runFilm } from "./internal/run";
export type {
  RecordOptions,
  Recorder,
  RecTarget,
  SettleOptions,
} from "./internal/record";
export { installRecorderClock, record } from "./internal/record";
