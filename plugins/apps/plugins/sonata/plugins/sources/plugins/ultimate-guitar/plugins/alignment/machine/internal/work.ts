import { songUltimateGuitar } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/server";
import { decideWork, type AlignmentWork } from "./decide";
import { songUgAlignment } from "../../server";

/** Read both rows and decide (`decideWork`). */
export async function readWork(songId: string): Promise<AlignmentWork> {
  const [tab, row] = await Promise.all([
    songUltimateGuitar.get(songId),
    songUgAlignment.get(songId),
  ]);
  if (tab === undefined) return { kind: "idle", reason: "no UG tab" };
  if (row === undefined) return { kind: "idle", reason: "no alignment row" };
  return decideWork(
    {
      tabId: tab.tabId,
      songName: tab.songName,
      artistName: tab.artistName,
      type: tab.type,
      key: tab.key,
      capo: tab.capo,
      tuning: tab.tuning,
      content: tab.content,
      urlWeb: tab.urlWeb,
    },
    row,
  );
}
