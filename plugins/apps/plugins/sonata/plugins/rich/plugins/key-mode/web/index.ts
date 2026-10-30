import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  keyAutoDetectSetting,
  SonataDocument,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { KeyModeObserver } from "./components/key-mode-observer";

export { saveKeyAutoDetect } from "./actions";

export default {
  description:
    "Per-song key-source mode: persists a toggle to override an authored (MIDI) key with auto-detection, and registers it with the song document's score pipeline as a per-song setting (SonataDocument.SongSetting) settled by a headless observer.",
  contributions: [
    SonataDocument.SongSetting({
      id: "key-mode-sync",
      setting: keyAutoDetectSetting,
      component: KeyModeObserver,
    }),
  ],
} satisfies PluginDefinition;
