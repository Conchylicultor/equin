import { type ReactNode, useCallback, useEffect, useState } from "react";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  SONG_LINK_KEYS,
  songLibrary,
  type SongId,
  type SongLinkKey,
} from "../core";
import { Library, type SongLinkValue } from "./slots";

/** The player route's params, as the pane hands them over. */
export interface PlayerParams {
  songId: string;
  bar?: string;
  lens?: string;
  title?: string;
  grid?: string;
  groove?: string;
}

type SongLinkPart = ReturnType<
  typeof Library.SongLink.useContributions
>[number];

/** The song link's own keys (the shareable content) with their values. */
type LinkParams = Partial<Record<SongLinkKey | "title", string>>;

/** How long the address waits for the edits to settle before it is rewritten. */
const MIRROR_DEBOUNCE_MS = 400;

/** A link's title when it carries none. */
const UNTITLED = "Shared song";

/**
 * The params with the song link's own keys replaced by `link` — `bar` and
 * `lens` (views of the song) kept as they are.
 */
export function withLink(params: PlayerParams, link: LinkParams): PlayerParams {
  return {
    songId: params.songId,
    ...(params.bar !== undefined && { bar: params.bar }),
    ...(params.lens !== undefined && { lens: params.lens }),
    ...link,
  };
}

/** The song link's own keys of `params`. */
function linkOf(params: PlayerParams): LinkParams {
  const out: LinkParams = {};
  for (const key of [...SONG_LINK_KEYS, "title"] as const) {
    const value = params[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sameLink(a: LinkParams, b: LinkParams): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as keyof LinkParams] !== b[key as keyof LinkParams]) return false;
  }
  return true;
}

/**
 * Keeps the address a link to the open song as it is now: every
 * `Library.SongLink` part's value (`;grid`, `;groove`, …), and the song's title
 * once a part that can recreate the song (`create`) has one — so the address
 * bar can be copied and opened on another library. Rewrites the current
 * history entry (a song's content changing is not a navigation), debounced so
 * typing in the grid does not rewrite it per keystroke, and only once every
 * part knows its value (a part still loading never drops its key).
 *
 * Each part reads through its own hook, so each is one {@link LinkPartReader}
 * element reporting its value up — a contributed set cannot be looped over
 * with hooks.
 */
export function SongLinkMirror({
  songId,
  params,
  setParams,
}: {
  songId: SongId;
  params: PlayerParams;
  setParams: (next: PlayerParams, opts: { replace: true }) => void;
}): ReactNode {
  const parts = Library.SongLink.useContributions();
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

  const title = rowOrStale(useLive(songLibrary, { id: songId }))?.title;

  // The link the song spells now, or null while a part (or the title it
  // needs) is not known yet.
  let next: LinkParams | null = {};
  let recreatable = false;
  for (const part of parts) {
    const value = values[part.key];
    if (value === undefined || !value.known) {
      next = null;
      break;
    }
    if (value.value === null) continue;
    next[part.key] = value.value;
    if (part.create !== undefined) recreatable = true;
  }
  if (next !== null && recreatable) {
    if (title === undefined) next = null;
    else next.title = title;
  }

  const paramsRef = useLatestRef(params);
  const nextKey = next === null ? null : JSON.stringify(next);
  useEffect(() => {
    if (nextKey === null) return;
    const link = JSON.parse(nextKey) as LinkParams;
    if (sameLink(link, linkOf(paramsRef.current))) return;
    const timer = setTimeout(() => {
      setParams(withLink(paramsRef.current, link), { replace: true });
    }, MIRROR_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [nextKey, paramsRef, setParams]);

  return (
    <>
      {parts.map((part) => (
        <LinkPartReader key={part.key} part={part} report={report} />
      ))}
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
    const ctx = { fetchEndpoint, openDialog };
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
