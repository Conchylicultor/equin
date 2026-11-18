export { songIdKind } from "./id-kind";
export type { SongId } from "./id-kind";
export { SONG_LINK_KEYS, sonataPlayerRoute } from "./player-route";
export { fromLinkText, toLinkText } from "./link-text";
export type { SongLinkKey } from "./player-route";
export { SongSchema, songsEntityRef } from "./schemas";

export { songLibrary } from "./resources";
export type { Song } from "./resources";

export { deleteSong, updateSong } from "./endpoints";
export type { UpdateSongBody } from "./endpoints";
export {
  songAttachmentLinksEntityRef,
  songAttachmentLinks,
} from "./attachment-links";
