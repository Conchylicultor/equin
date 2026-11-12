import { createHash } from "node:crypto";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";

// The piece the user is learning next: Grieg's Wedding-day at Troldhaugen,
// Lyric Pieces Op. 65 No. 6. Its score (A4 PDF) and MIDI are committed as
// fixtures (`data/scores/`, `data/music/`), byte for byte the Mutopia
// Project's public-domain edition (piece 781) — the composition (1896) and
// this edition are both in the public domain, so the film may show and play
// them with no credit owed.

const MUTOPIA = "https://www.mutopiaproject.org/ftp/GriegE/O65/troldhaugen";

export const PIECE = {
  title: "Wedding-day at Troldhaugen",
  composer: "Grieg",
  /** As the agent's note names it. */
  full: "Wedding-day at Troldhaugen, Lyric Pieces Op. 65 No. 6 (Grieg, 1896)",
  /** The Mutopia piece page (licence, edition). */
  sourcePage: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=781",
  licence: "Public Domain (Mutopia Project, Schirmer 1903 edition)",
  score: {
    /** Where it sits in the conversation's folder, and in the fixture dir. */
    path: "scores/wedding-day-at-troldhaugen.pdf",
    fixture: "data/scores/troldhaugen-a4.pdf",
    source: `${MUTOPIA}/troldhaugen-a4.pdf`,
    sha256: "986fe46381993b61dd6a826283226502ceb39c2c0068286bc18814b5fd507b71",
  },
  /** The score's first page as an image (rendered from the PDF with macOS `sips`, flattened onto white), to glance at. */
  page1: {
    path: "scores/wedding-day-at-troldhaugen-page-1.png",
    fixture: "data/scores/troldhaugen-p1.png",
    sha256: "338e299afd99e78bf32a5b16c51a13fa8b11315d0ad5c3a8543512ba3162aa9d",
  },
  midi: {
    path: "music/wedding-day-at-troldhaugen.mid",
    fixture: "data/music/troldhaugen.mid",
    source: `${MUTOPIA}/troldhaugen.mid`,
    sha256: "668205876de4597aa3647f0f85bf40f056205512dcb265ca3f549f408e952225",
  },
} as const;

const SEED_DIR = joinAppPath(
  PLUGINS_DIR,
  "apps/plugins/website/plugins/promo-film/plugins/seed",
);

/** A committed fixture, checked against its pinned hash (a swapped file is a loud seed failure). */
async function pinned(file: {
  fixture: string;
  sha256: string;
}): Promise<Uint8Array> {
  const path = joinAppPath(SEED_DIR, file.fixture);
  const bytes = new Uint8Array(await readFile(path));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== file.sha256)
    throw new Error(
      `[promo-film seed] ${path} is not the pinned Mutopia file (sha256 ${hash}, want ${file.sha256})`,
    );
  return bytes;
}

export const pieceScoreBytes = (): Promise<Uint8Array> => pinned(PIECE.score);
export const piecePage1Bytes = (): Promise<Uint8Array> => pinned(PIECE.page1);
export const pieceMidiBytes = (): Promise<Uint8Array> => pinned(PIECE.midi);

/**
 * The rest of the user's Piano folder (the Files app's start folder): other
 * pieces from the same Mutopia Project public-domain editions (the Chopin
 * nocturne from the recital, Bach's first prelude, Satie's Gymnopédie), each
 * committed byte for byte and pinned by sha256 like the Grieg files above.
 * `path` is where it sits in the folder; `daysAgo` its modified time.
 */
export const EXTRA_PIECES = [
  {
    path: "scores/chopin-nocturne-op9-no2.pdf",
    fixture: "data/scores/chopin-nocturne-op9-no2-a4.pdf",
    sha256: "049a434aa4c5b5c7b837001cbc02245c220c429fed27728df98b0860c05f6438",
    daysAgo: 41,
  },
  {
    path: "scores/bach-prelude-in-c.pdf",
    fixture: "data/scores/bach-prelude-bwv846-a4.pdf",
    sha256: "b1c5be9fb63954df9c1a3e7b651ae930c4e5e332a5ab3e14b197379cfa04c35a",
    daysAgo: 120,
  },
  {
    path: "music/chopin-nocturne-op9-no2.mid",
    fixture: "data/music/chopin-nocturne-op9-no2.mid",
    sha256: "e202d3941ce5f26397f57f59f0e2e4e3ad9e19061fa3c4dc596c5ee6a6a2548e",
    daysAgo: 38,
  },
  {
    path: "music/satie-gymnopedie-1.mid",
    fixture: "data/music/satie-gymnopedie-1.mid",
    sha256: "09ce7337b4bf42ba12e1aa64b4c7dc7fcfa6455f1070cb12f8880a755df97384",
    daysAgo: 96,
  },
] as const;

export const extraPieceBytes = (
  piece: (typeof EXTRA_PIECES)[number],
): Promise<Uint8Array> => pinned(piece);
