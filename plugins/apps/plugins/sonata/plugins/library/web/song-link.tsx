import { type ReactNode, useCallback, useEffect, useState } from "react";
import { rowOrStale, useLiveReader } from "@plugins/network/plugins/live/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  SONG_LINK_KEYS,
  sonataPlayerRoute,
  type SongId,
  type SongLinkKey,
} from "../core";
import { Library, type SongLinkValue } from "./slots";
import { useCurrentSong } from "./use-current-song";

/** The player route's params, as the pane hands them over. */
export interface PlayerParams {
  songId: string;
  bar?: string;
  lens?: string;
  title?: string;
  grid?: string;
  ug?: string;
  groove?: string;
}

type SongLinkPart = ReturnType<
  typeof Library.SongLink.useContributions
>[number];

/** The song link's own keys (the shareable content) with their values. */
type LinkParams = Partial<Record<SongLinkKey | "title", string>>;

/** A link's title when it carries none. */
const UNTITLED = "Shared song";

const shareIcon = symbol("share");

/** Whether `params` carry any of the song link's own keys (a share link). */
export function carriesSongLink(params: PlayerParams): boolean {
  return (
    params.title !== undefined ||
    SONG_LINK_KEYS.some((key) => params[key] !== undefined)
  );
}

/**
 * The params with the song link's own keys dropped — `bar` and `lens` (views
 * of the song) kept: the plain address of the song a share link opened.
 */
export function withoutLink(params: PlayerParams): PlayerParams {
  return {
    songId: params.songId,
    ...(params.bar !== undefined && { bar: params.bar }),
    ...(params.lens !== undefined && { lens: params.lens }),
  };
}

/**
 * The open song's Share button: copies a link that recreates the song on
 * another library — every `Library.SongLink` part's value (`;grid`, `;ug`,
 * `;groove`, …) and the song's title — and says so with a toast. Shown only
 * for a song a link can recreate (a `create` part has a value: a chord grid,
 * an Ultimate Guitar tab), and only once every part knows its value, so a
 * link never leaves out a part still loading. The address bar itself stays
 * the song's plain address.
 *
 * Each part reads through its own hook, so each is one {@link LinkPartReader}
 * element reporting its value up — a contributed set cannot be looped over
 * with hooks.
 */
export function ShareSongButton(): ReactNode {
  const parts = Library.SongLink.useContributions();
  const toast = useToast();
  const [values, setValues] = useState<
    Partial<Record<SongLinkKey, SongLinkValue>>
  >({});
  const report = useCallback((key: SongLinkKey, value: SongLinkValue) => {
    setValues((prev) => {
      const old = prev[key];
      if (
        old !== undefined &&
        old.known === value.known &&
        (!old.known || !value.known || old.value === value.value)
      ) {
        return prev;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const song = rowOrStale(useCurrentSong());

  // The link the song spells now, or null while a part (or the song) is not
  // known yet, or when no part can recreate the song elsewhere.
  let link: LinkParams | null = {};
  let recreatable = false;
  for (const part of parts) {
    const value = values[part.key];
    if (value === undefined || !value.known) {
      link = null;
      break;
    }
    if (value.value === null) continue;
    link[part.key] = value.value;
    if (part.create !== undefined) recreatable = true;
  }
  if (!recreatable || song === undefined || song === null) link = null;

  const copy = async () => {
    if (link === null || song === undefined || song === null) return;
    const path = sonataPlayerRoute.link(sonataApp, {
      songId: song.id,
      title: song.title,
      ...link,
    });
    const url = new URL(path, window.location.href).href;
    await navigator.clipboard.writeText(url);
    toast({
      type: "sonata-song-link-copied",
      variant: "success",
      title: "Link copied",
      description: `Opening it restores “${song.title}” as it is now.`,
      category: "confirmations",
    });
  };

  return (
    <>
      {parts.map((part) => (
        <LinkPartReader key={part.key} part={part} report={report} />
      ))}
      {link !== null && (
        <IconButton
          icon={shareIcon}
          label="Copy a link to this song"
          onClick={copy}
        />
      )}
    </>
  );
}

function LinkPartReader({
  part,
  report,
}: {
  part: SongLinkPart;
  report: (key: SongLinkKey, value: SongLinkValue) => void;
}): null {
  const value = part.useValue();
  const known = value.known;
  const text = value.known ? value.value : null;
  useEffect(() => {
    report(part.key, known ? { known: true, value: text } : { known: false });
  }, [part.key, known, text, report]);
  return null;
}

/**
 * The part of a link that can bring its song into being (a `create` part
 * whose key the link carries), with its value — or `null` when the link
 * names no song this library could create.
 */
export function useLinkCreator(
  params: PlayerParams,
): { part: SongLinkPart; value: string } | null {
  const parts = Library.SongLink.useContributions();
  for (const part of parts) {
    const value = params[part.key];
    if (part.create !== undefined && value !== undefined) {
      return { part, value };
    }
  }
  return null;
}

/**
 * A link to a song this library does not have, that carries what it takes to
 * create it: the song's title and an "Add to library" button, which creates
 * the song under the link's id from the creating part, then hands every other
 * part its value. Asked, never done on open, so a link only ever writes to the
 * library because its reader chose to keep it. Once the song exists, the
 * player opens it like any other.
 */
export function SongLinkImport({
  songId,
  params,
}: {
  songId: SongId;
  params: PlayerParams;
}): ReactNode {
  const parts = Library.SongLink.useContributions();
  const creator = useLinkCreator(params);
  const fetchEndpoint = useFetchEndpoint();
  const readLive = useLiveReader();
  const openDialog = useOpenDialog();
  const [failure, setFailure] = useState<string | null>(null);
  const title = params.title ?? UNTITLED;

  if (creator === null) {
    throw new Error(
      "SongLinkImport: rendered for a link that names no song to create",
    );
  }

  const add = async () => {
    setFailure(null);
    const ctx = { fetchEndpoint, readLive, openDialog };
    try {
      await creator.part.create?.(ctx, {
        id: songId,
        title,
        value: creator.value,
      });
      for (const part of parts) {
        const value = params[part.key];
        if (part === creator.part || value === undefined) continue;
        await part.apply?.(ctx, { id: songId, value });
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      setFailure(err.message);
    }
  };

  return (
    <Stack direction="col" gap="md">
      <Stack direction="col" gap="xs">
        <Text variant="heading">{title}</Text>
        <Text tone="muted">A shared song that is not in your library yet.</Text>
      </Stack>
      <div>
        <Button onClick={add}>Add to library</Button>
      </div>
      {failure !== null && <Text tone="destructive">{failure}</Text>}
    </Stack>
  );
}
