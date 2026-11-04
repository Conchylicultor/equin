import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { ugAlignJob } from "./job";
import { songUgAlignment } from "../../server";

/**
 * The UG sheet of a song changed (`sonata.ug.tabSaved`, on create and on every
 * content edit):
 *
 * - A song with no alignment row yet (just imported) gets one owned by the
 *   resolver (`pick: "auto"`, `queued`): the job will find it a video.
 * - A song with a video, or whose video the resolver owns, is handed to the
 *   job, which re-aligns the chosen video (or re-tries the candidates of one
 *   that needs a video) when the sheet really moved.
 * - A song whose user cleared nothing to align to is left alone.
 *
 * A plain job in between because a supervised job takes no event payload —
 * and deciding here keeps a song with nothing to do from spawning a child.
 */
export const onUgTabSavedJob = defineJob({
  name: "sonata.ug-alignment.on-tab-saved",
  description:
    "Starts choosing a recording for a new Ultimate Guitar song, and re-aligns one to its recording when its sheet changes.",
  hold: "instant",
  input: z.object({}),
  event: z.object({ songId: z.string() }),
  dedup: "none",
  run: async ({ event }) => {
    if (event === undefined) return;
    const row = await songUgAlignment.get(event.songId);
    if (row === undefined) {
      await songUgAlignment.upsert(event.songId, {
        videoId: null,
        pick: "auto",
        status: "queued",
        phase: null,
        error: null,
        errorPermanent: false,
      });
    } else if (row.videoId === null && row.pick === "user") {
      return;
    }
    await ugAlignJob.enqueue({ songId: event.songId });
  },
});
