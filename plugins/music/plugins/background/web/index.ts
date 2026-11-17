import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { backgroundMusicConfig } from "../shared/config";
import { BackgroundMusic } from "./slots";
import { BackgroundMusicRoot } from "./components/background-music-root";
import { MusicButton } from "./components/music-button";

export { BackgroundMusic } from "./slots";
export type {
  BackgroundMusicPlayerProps,
  BackgroundMusicSource,
} from "./slots";
export {
  useForegroundMusic,
  useMusicSource,
  type MusicSourceHandle,
} from "./internal/hooks";

export default {
  description:
    "The background music service: apps offer music as BackgroundMusic.Source contributions (an app, a kind, useTitle, and usePlayer — run from the page root, so the music outlives the app's views); the service plays one at a time per page and one page at a time in the browser (a BroadcastChannel claim, the playing page's state mirrored to the others' buttons and driven from them, a per-page Web Lock telling when it is gone). An app view reports itself on screen with useMusicSource(id, { shown }): when the last view leaves, its music pauses unless Keep playing across apps (config, on by default) is on; music an app plays itself (useForegroundMusic) pauses background music nobody sees. The global action bar's music button (a note, moving bars while playing) opens the panel: now playing with its app, play / pause, the device's volume and stop; every app's music; and the across-apps switch.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: backgroundMusicConfig }),
    Core.Root({ component: BackgroundMusicRoot, scope: "page" }),
    ActionBar.Item({ id: "music", component: MusicButton }),
  ],
  slots: BackgroundMusic,
} satisfies PluginDefinition;
