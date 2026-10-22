import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  openSongImperative,
  type SourceCreateOption,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { compile, type ChordGridRaw } from "../compile";
import { createChordGridSong } from "../../shared/endpoints";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const gridViewIcon = symbol("grid-view");

/**
 * The chord-grid source's create affordance, contributed to `Library.Source`
 * and mapped by the library into the data-view `creators` "+" menu. Creates a
 * new song pre-filled with a starter progression (the grid is authored, not
 * imported), computes its metrics client-side via `compile`, persists it, then
 * opens it immediately (via the imperative `openSongImperative`) so the user
 * lands in the editor. Fully imperative — no React hooks: the library hands it
 * the surface's fetcher.
 *
 * The starter is the mini-language's real first impression — the loader's
 * placeholder never shows, since a new grid is born non-empty. So it leads with
 * a `#` comment (teaching the section-label idiom) and keeps the legacy `|`
 * form, which still parses.
 */
const STARTER: ChordGridRaw = {
  text: "# Verse\n| C  G | Am  F |",
};

export const chordGridCreateOption: SourceCreateOption = {
  id: "chord-grid",
  label: "New Chord Grid",
  description: "Author a chord progression and hear it voiced.",
  icon: <Icon icon={gridViewIcon} className="size-4" />,
  onSelect: async ({ fetchEndpoint }) => {
    const score = compile(STARTER);
    const endBeat = scoreEndBeat(score);
    const song = await fetchEndpoint(
      createChordGridSong,
      {},
      {
        body: {
          title: "New Chord Grid",
          composer: null,
          chordText: STARTER.text,
          durationSec: beatToSeconds(score, endBeat),
          endBeat,
        },
      },
    );
    openSongImperative(song);
  },
};
