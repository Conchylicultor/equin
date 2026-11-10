/**
 * Identity of the General MIDI soundfont's sample mirror, shared by this
 * plugin's web voices (which build smplr's `instrumentUrl` from it) and its
 * server barrel (which registers the mirror). Plugin-private DRY — lives in
 * `shared/`, never imported cross-plugin. A plugin naming its own mirror is
 * fine; the asset-mirror primitive stays generic and never names the soundfont.
 */

/** Mirror id → URL segment `/api/asset-mirror/gm-soundfont/…`. */
export const SOUNDFONT_MIRROR_ID = "gm-soundfont";

/**
 * smplr's default soundfont CDN, pinned to one kit directory. smplr's
 * `Soundfont` loads each instrument from Benjamin Gleitzman's pre-rendered
 * `midi-js-soundfonts` package: `<kit>/<gleitz-name>-<format>.js`. We bake the
 * kit (`MusyngKite` — smplr's default, the better-sounding of the two) into the
 * base so the *remaining* path segment the mirror sees is a single FLAT file
 * name (`flute-mp3.js`), satisfying the asset-mirror route's flat-file
 * constraint (it rejects any `:file` containing `/`). The mirror fetches
 * `<base>/<file>` on a cache miss and serves it same-origin thereafter, so the
 * browser only ever talks to the local server after one warm-up.
 *
 * Format is fixed to `mp3` (see web/voices.ts): mp3 is universally supported, so
 * unlike the piano's ogg/m4a split there is no per-browser format negotiation.
 */
export const SOUNDFONT_REMOTE_BASE =
  "https://gleitz.github.io/midi-js-soundfonts/MusyngKite";

/** The file smplr's `Soundfont` fetches for one gleitz patch slug: `<gleitz>-mp3.js` (mp3 — see `web/voices.ts`). */
export function soundfontFile<G extends string>(gleitz: G): `${G}-mp3.js` {
  return `${gleitz}-mp3.js`;
}
