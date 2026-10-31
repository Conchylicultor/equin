import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGINS_DIR } from "@plugins/infra/plugins/paths/core";

// The recital piece: Chopin's Fantaisie-Impromptu in C-sharp minor, Op. 66.
// Its MIDI is committed as a fixture (`data/music/`), byte for byte the
// Mutopia Project's public-domain edition — the composition (1834) and this
// encoding are both in the public domain, so the film may play it.

export const PIECE = {
  title: "Fantaisie-Impromptu",
  composer: "Chopin",
  /** As the Piano page names it. */
  full: "Fantaisie-Impromptu in C♯ minor, Op. 66 (Chopin)",
  fileName: "fantaisie-impromptu.mid",
  /** The MIDI's own source, licence and credit (Mutopia piece 1693). */
  source:
    "https://www.mutopiaproject.org/ftp/ChopinFF/O66/chopin_fantaisie-impromptu/chopin_fantaisie-impromptu.mid",
  sourcePage: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1693",
  licence: "Public Domain (Mutopia Project; typeset by Guy D. Lederfein)",
  sha256: "b29f6add7473b6e931c2e66349e860bf0e884cf68e19e90420a4870aae689f96",
} as const;

const FILE = join(
  PLUGINS_DIR,
  "apps/plugins/website/plugins/promo-film/plugins/seed/data/music",
  PIECE.fileName,
);

/** The committed MIDI, checked against its pinned hash (a swapped file is a loud seed failure). */
export function pieceMidiBytes(): Uint8Array {
  const bytes = new Uint8Array(readFileSync(FILE));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== PIECE.sha256)
    throw new Error(
      `[promo-film seed] ${FILE} is not the pinned Mutopia file (sha256 ${hash}, want ${PIECE.sha256})`,
    );
  return bytes;
}
