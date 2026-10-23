import { renderRollCover } from "@plugins/apps/plugins/sonata/plugins/covers/core";
import type { ScoreCoverRequest } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import { parseMidi } from "../../shared/parse";

/** What the cover route needs to know about one song's MIDI. */
export interface MidiCoverSong {
  /** The row's `sourcesChangedAt` now, as epoch ms — the current URL version. */
  current: string;
  /** The stored bytes' content hash — the cover cache key. */
  contentHash: string;
  /** The stored `.mid` bytes. */
  readBytes: () => Promise<Uint8Array>;
}

export interface MidiCoverDeps {
  /** The song's MIDI, or null when the song carries none. */
  lookup: (id: string) => Promise<MidiCoverSong | null>;
  serve: (req: ScoreCoverRequest) => Promise<Response>;
}

/** `<epoch ms>.svg` — the only last segment the route serves. */
const FILE_PATTERN = /^(\d+)\.svg$/;

/**
 * The MIDI cover route over its dependencies: 400 for a last segment that is
 * not `<integer>.svg`, 404 for a song without MIDI, else the song's roll cover
 * through `serve` — the bytes read, parsed and drawn only on a cache miss.
 */
export function createMidiCoverHandler(
  deps: MidiCoverDeps,
): (req: Request, params: Record<string, string>) => Promise<Response> {
  return async (_req, params) => {
    const match = FILE_PATTERN.exec(params.file ?? "");
    if (!match) return new Response("invalid cover version", { status: 400 });
    const song = await deps.lookup(params.id ?? "");
    if (!song) return new Response("no MIDI for this song", { status: 404 });
    return deps.serve({
      version: match[1]!,
      current: song.current,
      contentHash: song.contentHash,
      render: async () => renderRollCover(parseMidi(await song.readBytes())),
    });
  };
}
