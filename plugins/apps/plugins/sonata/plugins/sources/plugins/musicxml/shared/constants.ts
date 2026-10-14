/**
 * Stable id of the MusicXML source — the key under which its raw lives in
 * `rawById`, the `sourceId` of its `Library.Source` / `SonataDocument.Source`
 * contributions, and the opaque `source` discriminator stamped onto the
 * `sonata_songs` row at creation. In `shared/` so the server create path stamps
 * the same id without a web import.
 */
export const MUSICXML_SOURCE_ID = "musicxml";

/** The MIME type a stored MusicXML attachment carries. */
export const MUSICXML_MIME = "application/vnd.recordare.musicxml+xml";
