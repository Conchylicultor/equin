import { z } from "zod";
import { defineKept } from "@plugins/primitives/plugins/kept-state/web";

/**
 * Where a session's playhead stood in a song, kept as view state so a reload
 * or a remount (tab residency unmounts a hidden tab) resumes there — PAUSED:
 * playback is a process, and a process never resumes playing on its own.
 *
 *  - `song`: the host's name for what was loaded (`PlaybackSession`'s
 *    `keepAs`); the record is restored only into that same song.
 *  - `beat`: the playhead — exact when it was paused or sought, the bar it
 *    was in while it played (written once per bar, not per frame).
 *  - `loop`: the A–B loop, which belongs to the song's beat span.
 *  - `openedAt`: the beat the load's seek intent (a deep link's bar) resolved
 *    to. A remount re-arms the same intent; it outranks the kept beat only when
 *    it names another beat — a new link, not the one already honoured here.
 *
 * One entry per place (the ambient `KeepScope`): a place shows one session.
 */
export const keptPlayhead = defineKept({
  owner: "sonata.session.playhead",
  tier: "view",
  schema: z
    .object({
      song: z.string(),
      beat: z.number(),
      loop: z
        .object({ start: z.number(), end: z.number(), enabled: z.boolean() })
        .nullable(),
      openedAt: z.number().nullable(),
    })
    .nullable(),
});

export type KeptPlayhead = NonNullable<z.infer<typeof keptPlayhead.schema>>;

/**
 * The playback tempo multiplier, kept per place. Not per song: like the
 * session's own state, the tempo carries over to the next song loaded.
 */
export const keptTempo = defineKept({
  owner: "sonata.session.tempo",
  tier: "view",
  schema: z.number().min(0).max(4),
});
