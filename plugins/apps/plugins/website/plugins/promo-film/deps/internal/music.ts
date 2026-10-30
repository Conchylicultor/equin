import { defineDep } from "@plugins/infra/plugins/deps/deps";
import { download } from "@plugins/infra/plugins/deps/plugins/download/deps";

const FILE = "the_budding_of_consciousness.wav";

/**
 * The promo film's music: "The Budding of Consciousness" (Yoiyami Blue Series
 * No.4) by Yoiyami, CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/).
 * Source page:
 * https://opengameart.org/content/the-budding-of-consciousness-%E2%80%93-cc0-ambient-minimalist-theme-yoiyami-blue-series-%E2%80%93-no4
 * Warm piano, shimmering pads, faint low-frequency pulse, no percussion.
 * 48 kHz stereo 16-bit WAV, 3:44, ~70.6 BPM. Pinned by sha256.
 */
export const promoMusic = defineDep({
  id: "promo-music",
  owner: "apps/website/promo-film",
  description:
    '"The Budding of Consciousness" by Yoiyami (CC0), the promo film\'s music track',
  sizeHint: "≈43 MB",
  source: download({
    files: [
      {
        name: FILE,
        url: "https://opengameart.org/sites/default/files/the_budding_of_consciousness.wav",
        sha256:
          "c879c57f4353c16926026e05fea372be64a73356ea663475aa1f54bf5499b513",
      },
    ],
    admission: {
      none: "one 43 MB download, not CPU- or memory-heavy",
    },
  }),
  updates: {
    none: "pinned track; a different recording would change the film's cut, so it is swapped by hand",
  },
});

/**
 * The track's musical facts the edit is cut to. Measured on a mono decode:
 * 1 s RMS envelope + onset-energy autocorrelation (70.6 BPM; beat grid phase
 * 0.69 s, confirmed on the 56-100 s section). All times are seconds into the file.
 */
export const PROMO_MUSIC = {
  file: FILE,
  title: "The Budding of Consciousness",
  artist: "Yoiyami",
  license: "CC0 1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  sourceUrl:
    "https://opengameart.org/content/the-budding-of-consciousness-%E2%80%93-cc0-ambient-minimalist-theme-yoiyami-blue-series-%E2%80%93-no4",
  /** null for CC0: no attribution required. Optional courtesy credit: "Music by Yoiyami (CC0)". */
  attribution: null as string | null,
  bpm: 70.6,
  /** One beat / one 4-beat bar in seconds. Cut on multiples of these from `firstDownbeat`. */
  beatSeconds: 0.8499,
  barSeconds: 3.3994,
  /** Seconds into the file of a beat-grid downbeat (bar 1); bar n starts at firstDownbeat + (n-1) * barSeconds. */
  firstDownbeat: 0.69,
  /** Total length of the file, seconds. */
  duration: 223.96,
  /**
   * Where film t=0 starts in the file: ~10.1 s, so the lift at 55.1 s (bar 17,
   * the 16-bar mark) lands at film t=45 s, right after the beat of silence at
   * ~43 s, and the full section runs under film 45..64 (it holds until 102 s).
   */
  sectionStart: 10.09,
  /** Seconds into the file where the fuller section enters (bar 17: piano + pad lift, about +9 dB). */
  dropAt: 55.09,
  /** Sections by file time (RMS dB is the 1 s average, full scale 0). */
  sections: [
    {
      from: 0,
      to: 40,
      name: "sparse",
      note: "soft piano + pad, faint pulse; about -28 dB, breathing room",
    },
    {
      from: 40,
      to: 55,
      name: "build",
      note: "piano gets denser, level creeps up toward -25 dB",
    },
    {
      from: 55.1,
      to: 102,
      name: "full",
      note: "the lift: about -18 dB, steady, the peak section",
    },
    {
      from: 102,
      to: 109,
      name: "breakdown",
      note: "drops back to about -30 dB, then re-enters",
    },
    {
      from: 109,
      to: 200,
      name: "full",
      note: "second long full section, -17..-20 dB",
    },
    {
      from: 200,
      to: 224,
      name: "outro",
      note: "thins out and decays to silence by the end of the file",
    },
  ],
} as const;
