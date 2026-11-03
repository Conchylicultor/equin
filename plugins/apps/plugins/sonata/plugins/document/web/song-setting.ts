import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";

/**
 * One per-song setting — transpose, key mode, chord mode, groove, track view —
 * as a song document holds it for the loaded song: `pending` until the feature
 * plugin that persists it has read that song's value, then `settled` with the
 * value — or `failed` when that read failed with no last-known value to settle
 * from, so a surface renders the failure (with Retry) instead of waiting on a
 * value that will never come.
 *
 * Not known yet is a STATE here, never a stand-in. The two stand-ins it
 * replaces were each wrong for a round trip: the setting's default (a muted
 * track sounds, a transposed song plays in its original key) and the previous
 * song's value (song B plays in song A's key). The document composes (so
 * nothing shows or plays) no score until every per-song setting registered in
 * the running composition has settled.
 */
export type SongSetting<T> =
  | { kind: "pending" }
  | ({ kind: "failed" } & SongSettingFailure)
  | { kind: "settled"; value: T };

/** Why a setting could not be settled, and how to retry the read behind it. */
export interface SongSettingFailure {
  error: ResourceError;
  refetch: () => Promise<void>;
}

/**
 * A per-song setting's identity and value type. Its value lives in the loaded
 * document (`loaded-song.tsx`), keyed by THIS OBJECT — so two settings can
 * never collide on a name. Defined once, by the plugin that reads it: the
 * document for the settings its score pipeline transforms with, a feature
 * plugin for one only it reads (the track-mixer's track view).
 *
 * A setting is only waited on when the running composition registers it — a
 * `SonataDocument.SongSetting` contribution pairing it with the observer that
 * settles it for the loaded library song.
 */
export interface SongSettingKey<T> {
  /** For messages only — identity is the object. */
  readonly name: string;
  /**
   * The song's value in a composition WITHOUT the feature that persists this
   * setting: the truth there, not a stand-in — with no transpose feature, no
   * song is transposed. A reader gets it while nothing registers the
   * setting, and always for a file document (which has no persisted
   * settings); a registered setting of a library song is pending until its
   * observer settles it. Required, so every setting has a default to settle to.
   */
  readonly absent: T;
}

export function defineSongSetting<T>(
  name: string,
  absent: T,
): SongSettingKey<T> {
  return { name, absent };
}
