import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataDocument } from "./slots";

export { SonataDocument } from "./slots";
export { sameIdentity, type SongIdentity } from "./identity";
export {
  SongDocumentProvider,
  useSongDocument,
  type DocumentContent,
  type SongDocumentValue,
} from "./document";
export {
  defineSongSetting,
  type SongSetting,
  type SongSettingFailure,
  type SongSettingKey,
} from "./song-setting";
export {
  useLoadDocument,
  useLibrarySong,
  useLoadCount,
  useSongSetting,
  useWriteSongSetting,
  useFailSongSetting,
  type LibrarySong,
} from "./loaded-song";
export { SongSettingsMount, useMountedSongId } from "./song-setting-mount";
export {
  transposeSetting,
  keyAutoDetectSetting,
  chordModeSetting,
  swingSetting,
  defaultGroove,
  grooveSetting,
  type RhythmGroove,
} from "./score-settings";
export {
  useHasChords,
  useHasDerivedChord,
  useHasVoicedChords,
} from "./score-gates";

export default {
  description:
    "Sonata song document: a song's identity (a library song or a file), its sources' raw input and its per-song settings as one per-surface state, composed into a score through the source → merge → transpose → voicing → key → spelling → analyzer → chord-mode → swing pipeline. Defines the SonataDocument.{Source,Analyzer,SongSetting} registries; a file document settles every setting to its default and mounts no observer.",
  slots: { ...SonataDocument },
} satisfies PluginDefinition;
