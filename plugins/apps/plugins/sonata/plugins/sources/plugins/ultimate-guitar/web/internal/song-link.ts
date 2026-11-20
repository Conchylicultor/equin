import { useSongDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import {
  Library,
  type LinkPreviewResult,
  type SongLinkValue,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  UgSourceRawSchema,
  type UgSourceRaw,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { createUltimateGuitarSong } from "../../shared/endpoints";
import { compile } from "../compile";
import { ugTab } from "../../shared/resources";
import { readUgTab } from "./ug-unavailable";

/** The tab a link's `;ug=` names, as the import dialog spells a tab id. */
function tabUrl(tabId: string): string {
  return `https://tabs.ultimate-guitar.com/tab/${tabId}`;
}

/**
 * The open song's Ultimate Guitar tab, as its link spells it (`;ug=`): the
 * loaded tab's id — the tab itself is UG's, fetched again by whoever opens the
 * link — or none for a song with no UG tab.
 */
function useUgLinkValue(): SongLinkValue {
  const raw = useSongDocument().sourceRaw(UG_SOURCE_ID);
  if (raw === undefined) return { known: true, value: null };
  return { known: true, value: UgSourceRawSchema.parse(raw).tab.tabId };
}

/**
 * A link's tab as the source's raw, fetched from UG as the import does
 * (`loading` meanwhile; a tab UG refuses, or cannot be reached for, is the
 * error arm) — unaligned, as a song just imported is.
 */
function useUgPreview(value: string): LinkPreviewResult {
  const tab = useLive(ugTab, { url: tabUrl(value) });
  // Read by the computer: a host without one (the in-browser demo) says so.
  if (tab.status === "unavailable") return tab;
  return mapResource(tab, (data) => {
    const raw: UgSourceRaw = { tab: data, alignment: null };
    return { sourceId: UG_SOURCE_ID, raw };
  });
}

/**
 * Ultimate Guitar's part of a song's share link: the tab id, and — for a link
 * to a song this library does not have — the song itself: the tab fetched from
 * UG, previewed, then (Add to library) created under the link's id and title,
 * measured as the import does.
 * A tab UG refuses (gone) or cannot be reached for throws, which the link's
 * Add to library card shows.
 */
export const ugSongLink = Library.SongLink({
  key: "ug",
  useValue: useUgLinkValue,
  usePreview: useUgPreview,
  create: async ({ fetchEndpoint, readLive }, { id, title, value }) => {
    const answer = await readUgTab(readLive, tabUrl(value));
    if (answer.status === "refused" || answer.status === "unavailable") {
      throw new Error(answer.message);
    }
    const tab = answer.data;
    const score = compile({ tab, alignment: null });
    const endBeat = scoreEndBeat(score);
    await fetchEndpoint(
      createUltimateGuitarSong,
      {},
      {
        body: {
          ...tab,
          id,
          title,
          durationSec: beatToSeconds(score, endBeat),
          endBeat,
        },
      },
    );
  },
});
