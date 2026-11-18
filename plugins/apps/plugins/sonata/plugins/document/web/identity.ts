/**
 * Which song a document is. A union, so a file opened for preview can never be
 * mistaken for a library song — and so nothing persisted per library song
 * (settings, play counts) can be read or written for a file:
 *
 *  - `library`: a saved Sonata song. Its per-song settings are persisted by
 *    their feature plugins and settled by the registered observers.
 *  - `file`: content read from a file outside the library (`key` names the
 *    file, e.g. its file-ref key; `name` is what the user knows it as — its
 *    file name — where a library song has its title). It has no persisted
 *    settings: every setting reads its `absent` value, and no setting can be
 *    written.
 */
export type SongIdentity =
  | { kind: "library"; songId: string }
  | { kind: "file"; key: string; name: string };

/**
 * `identity` as one stable string (`library:<songId>` / `file:<key>`) — what
 * keys per-song state that outlives the identity object: a player remounted
 * per song, a playhead kept across a reload.
 */
export function songIdentityKey(identity: SongIdentity): string {
  return identity.kind === "library"
    ? `library:${identity.songId}`
    : `file:${identity.key}`;
}

/** Whether `a` and `b` name the same document. */
export function sameIdentity(a: SongIdentity, b: SongIdentity): boolean {
  switch (a.kind) {
    case "library":
      return b.kind === "library" && a.songId === b.songId;
    case "file":
      return b.kind === "file" && a.key === b.key;
  }
}
