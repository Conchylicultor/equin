import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";

/** What the service hands the source's player: whether to sound, and how loud. */
export interface BackgroundMusicPlayerProps {
  readonly playing: boolean;
  /** The listener's volume as a gain in [0, 1]. */
  readonly gain: number;
}

export interface BackgroundMusicSource {
  /** The source's id, stable: the app's views and the service name it by it. */
  readonly id: string;
  /** The app the music belongs to: its icon and name, and where "open the app" goes. */
  readonly app: AppRef;
  /** What kind of music it is, in words ("Ambience"). */
  readonly kind: string;
  /** What plays now, in words (a mood's track name). */
  readonly useTitle: Hook<() => string>;
  /**
   * Where what plays now lives, as a route (a Sonata song's page): the music
   * button's now-playing card opens it. Default: the app's base path.
   */
  readonly useHref?: Hook<() => string>;
  /**
   * Plays the source's music while `playing`. Called from the page root by
   * the service — never inside the app — so the music outlives the app's
   * views; called while the source is current, and (idle) while the music
   * button's panel is open, so the audio is ready before the click.
   */
  readonly usePlayer: Hook<(props: BackgroundMusicPlayerProps) => void>;
  /**
   * Whether the source has music to offer now (default: always). A source
   * that only carries music an app handed it (a Sonata song playing on after
   * its page went away) is listed only while it has some.
   */
  readonly useAvailable?: Hook<() => boolean>;
  /**
   * The source keeps its own volume (a Sonata song, at the level its player
   * set): the panel shows no device slider for it, and `gain` is not applied.
   */
  readonly ownVolume?: boolean;
  /**
   * The source puts its music in the browser's media session itself (a
   * Sonata song: its scrubber and seeking), so the service does not. Default:
   * the service does, with the source's title, its app's name and icon, and
   * play / pause / stop.
   */
  readonly ownsMediaSession?: boolean;
}

export const BackgroundMusic = {
  /**
   * A source of background music an app offers: Isle's ambience, a Sonata
   * song playing on after its page went away. The music
   * button lists every source; the service plays one at a time.
   *
   * ```ts
   * BackgroundMusic.Source({ id: "isle", app: isleApp, kind: "Ambience", useTitle, usePlayer })
   * ```
   */
  Source: defineSlot<BackgroundMusicSource>({ docLabel: (c) => c.id }),
};
