import { renderStaffCover } from "@plugins/apps/plugins/sonata/plugins/covers/core";
import type { ScoreCoverRequest } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import { parseMusicXml } from "../../shared/parse";

/** What the cover route needs to know about one song's MusicXML. */
export interface MusicXmlCoverSong {
  /** The row's `sourcesChangedAt` now, as epoch ms — the current URL version. */
  current: string;
  /** The stored document's content hash — the cover cache key. */
  contentHash: string;
  /** The stored document's text. */
  readXml: () => Promise<string>;
}

export interface MusicXmlCoverDeps {
  /** The song's MusicXML, or null when the song carries none. */
  lookup: (id: string) => Promise<MusicXmlCoverSong | null>;
  serve: (req: ScoreCoverRequest) => Promise<Response>;
}

/** `<epoch ms>.svg` — the only last segment the route serves. */
const FILE_PATTERN = /^(\d+)\.svg$/;

/**
 * The MusicXML cover route over its dependencies: 400 for a last segment that
 * is not `<integer>.svg`, 404 for a song without MusicXML (a transcription
 * still running has none yet), else the song's staff cover through `serve` —
 * the document read, parsed and drawn only on a cache miss.
 */
export function createMusicXmlCoverHandler(
  deps: MusicXmlCoverDeps,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (_req, params) => {
    const match = FILE_PATTERN.exec(params.file ?? "");
    if (!match) return new Response("invalid cover version", { status: 400 });
    const song = await deps.lookup(params.id ?? "");
    if (!song)
      return new Response("no MusicXML for this song", { status: 404 });
    return deps.serve({
      version: match[1]!,
      current: song.current,
      contentHash: song.contentHash,
      render: async () => renderStaffCover(parseMusicXml(await song.readXml())),
    });
  };
}
