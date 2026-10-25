import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ColorTokenRef } from "@plugins/ui/plugins/tokens/plugins/color-ref/core";
import type { ComponentType } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { defineMountSlot } from "@plugins/primitives/plugins/slot-render/web";
import type {
  Annotation,
  Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { SongSettingKey } from "./song-setting";

/**
 * The registries a song document is composed from. Read generically by the
 * document's score pipeline, so it names no source, analyzer or setting
 * feature — and a composition without one of them simply composes without it.
 */
export const SonataDocument = {
  // INPUT — data registry. `compile` turns a source's raw input into a Score
  // (pure); the document compiles every source that has raw input and merges
  // them. `LoaderComponent` is the UI to provide input (dropzone / text
  // editor): `raw` is the source's currently-loaded input so an editor renders
  // *controlled*, `onRaw` feeds new input back.
  Source: defineSlot<{
    id: string;
    label: string;
    icon?: IconRef;
    // The source's colour, a declared colour token: the library's source
    // chip / dot / group chip and the quiet cover's wash are drawn in it.
    tint?: ColorTokenRef;
    LoaderComponent: ComponentType<{
      raw?: unknown;
      onRaw: (raw: unknown) => void;
    }>;
    compile: (raw: unknown) => Score;
  }>({ docLabel: (p) => p.label }),

  // RICH DATA — pure analyzers; emit only source:"derived". All run, their
  // annotations merged into the composed score.
  Analyzer: defineSlot<{
    id: string;
    analyze: (score: Score) => Annotation[];
  }>({ docLabel: (p) => p.id }),

  // SONG SETTING — the registry of per-song settings: each contribution pairs a
  // setting (`setting`, a `defineSongSetting` key) with the headless observer
  // (`component`) that settles it for the loaded LIBRARY song. Every observer
  // is mounted while a library song is loaded, afresh for each song loaded
  // (keyed on the load), so an observer reads the non-null `useMountedSongId()`
  // and starts from that song's own state. The score waits on exactly the
  // settings registered here — read generically, so the document names no
  // feature, and a composition without one of them never waits on it. A file
  // document mounts no observer: every setting reads its `absent` value. One
  // contribution per setting.
  SongSetting: defineMountSlot<{ setting: SongSettingKey<unknown> }>({
    docLabel: (p) => p.id,
  }),
};
