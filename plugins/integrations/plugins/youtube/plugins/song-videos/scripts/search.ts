// ─── Find a song's videos from a terminal ────────────────────────────────────
//
//   ./singularity run plugins/integrations/plugins/youtube/plugins/song-videos/scripts/search.ts <artist> <title>
//
// The live `youtube-search` source end to end — yt-dlp's flat search (the real
// Python entry), the oEmbed embeddability check and the ranking — through the
// same pipeline `findSongVideos` runs (`findSongVideosWith`), and prints the
// ranked candidates with their reasons. The `hooktheory` source needs a booted
// backend's database, so it is left out here.
import { ensureDepViaCli } from "@plugins/infra/plugins/deps/deps";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import { ytDlpDep } from "@plugins/integrations/plugins/youtube/deps";
import {
  checkOembed,
  searchYouTubeWith,
} from "@plugins/integrations/plugins/youtube/server";
import { findSongVideosWith } from "../server/internal/find";

const [artist, title] = process.argv.slice(2);
if (artist === undefined || title === undefined) {
  console.error("usage: search.ts <artist> <title>");
  process.exit(2);
}

// A script holds no ExecContext: yt-dlp is installed through a
// `./singularity deps install` child instead, and the one source here takes
// the `Ready` proof directly, never the context.
const ready = await ensureDepViaCli(ytDlpDep, {
  stdio: "inherit",
  grant: null,
});
const noExec = {} as ExecContext;

const started = Date.now();
const result = await findSongVideosWith(
  {
    sources: [
      {
        id: "youtube-search",
        find: async (query, _exec, { log }) => ({
          kind: "answered",
          videos: (
            await searchYouTubeWith(ready, `${query.artist} ${query.title}`, {
              limit: 10,
              log,
            })
          ).map((r) => ({ ...r, evidence: "search" as const })),
        }),
      },
    ],
    checkEmbed: checkOembed,
  },
  { artist, title },
  noExec,
  { log: (line) => console.error(`  ${line}`) },
);

console.log(`\n"${artist} – ${title}" — ${Date.now() - started} ms`);
for (const s of result.sources) console.log(`source ${s.source}: ${s.kind}`);
for (const r of result.refused)
  console.log(`refused ${r.videoId}: ${r.status}`);
result.candidates.forEach((c, i) => {
  const duration =
    c.durationSec === null
      ? "  ?  "
      : `${Math.floor(c.durationSec / 60)}:${String(Math.round(c.durationSec % 60)).padStart(2, "0")}`;
  console.log(
    `#${i} ${c.match.toFixed(2).padStart(5)}  ${c.videoId}  ${duration}  "${c.title ?? "?"}" · ${c.channel ?? "?"}`,
  );
  console.log(`      ${c.reasons.join(", ")}`);
});
