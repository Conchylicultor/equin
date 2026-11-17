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
   * Plays the source's music while `playing`. Called from the page root by
   * the service — never inside the app — so the music outlives the app's
   * views; called while the source is current, and (idle) while the music
   * button's panel is open, so the audio is ready before the click.
   */
  readonly usePlayer: Hook<(props: BackgroundMusicPlayerProps) => void>;
}

export const BackgroundMusic = {
  /**
   * A source of background music an app offers: Isle's ambience. The music
   * button lists every source; the service plays one at a time.
   *
   * ```ts
   * BackgroundMusic.Source({ id: "isle", app: isleApp, kind: "Ambience", useTitle, usePlayer })
   * ```
   */
  Source: defineSlot<BackgroundMusicSource>({ docLabel: (c) => c.id }),
};
