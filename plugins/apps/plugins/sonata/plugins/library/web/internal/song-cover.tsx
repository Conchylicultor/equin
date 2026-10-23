import { useState, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Layer,
  layerClasses,
} from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { SonataDocument } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Song } from "../../core";
import type { SongCoverAnswer } from "../slots";

const musicNoteIcon = symbol("music-note");
const errorIcon = symbol("error");

/**
 * The quiet base's tint per categorical slot — a low wash of the slot under
 * the slot-coloured glyph. Literal strings so Tailwind's scanner sees them.
 */
const SOURCE_TINTS = [
  "bg-categorical-1/12 text-categorical-1",
  "bg-categorical-2/12 text-categorical-2",
  "bg-categorical-3/12 text-categorical-3",
  "bg-categorical-4/12 text-categorical-4",
  "bg-categorical-5/12 text-categorical-5",
  "bg-categorical-6/12 text-categorical-6",
  "bg-categorical-7/12 text-categorical-7",
  "bg-categorical-8/12 text-categorical-8",
  "bg-categorical-9/12 text-categorical-9",
  "bg-categorical-10/12 text-categorical-10",
] as const;

/** A source's tint: a stable hash of its id, so a source keeps its colour
 *  across reloads, sessions and machines. */
function sourceTint(sourceId: string): string {
  return SOURCE_TINTS[hash53(sourceId) % SOURCE_TINTS.length]!;
}

export interface SongCoverProps {
  song: Song;
  /** The resolved `Library.Cover` answer (`resolveSongCover`); `undefined`
   *  when no source answers — the quiet cover alone. */
  answer: SongCoverAnswer | undefined;
}

/**
 * A song's cover, filling the data-view cover frame (gallery card picture or
 * list thumbnail). It always paints the QUIET base — the song source's glyph
 * on that source's tint — so a song nothing draws art for still has a cover
 * (never an "empty" claim). On top of it:
 *
 * - `art` — the picture: an image (decoded off the main thread; a load error
 *   drops back to the base with the failure badge) or the source's own node;
 * - `pending` — a loading marker with its label: the cover is being made;
 * - `failed` — a visible "Cover failed" badge, the message as its tooltip.
 */
export function SongCover({ song, answer }: SongCoverProps): ReactNode {
  const sources = SonataDocument.Source.useContributions();
  const source = sources.find((s) => s.id === song.source);
  // The image's own failure, keyed by its URL: a new URL tries again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const image =
    answer?.kind === "art" && answer.content.kind === "image"
      ? answer.content
      : null;
  const imageFailed = image !== null && failedSrc === image.src;
  // An icon answer takes the glyph's place on the tint (two glyphs would stack).
  const iconArt =
    answer?.kind === "art" && answer.content.kind === "icon"
      ? answer.content.icon
      : null;
  const failure =
    answer?.kind === "failed"
      ? answer.message
      : imageFailed
        ? `The cover image did not load (${image.src}).`
        : null;

  return (
    <Layer>
      <Center className={cn("size-full", sourceTint(song.source))}>
        <Icon
          icon={iconArt ?? source?.icon ?? musicNoteIcon}
          className="size-[30%] max-h-10 max-w-10 opacity-80"
        />
      </Center>
      {image !== null && !imageFailed ? (
        <img
          src={image.src}
          alt={image.alt ?? ""}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={() => setFailedSrc(image.src)}
          className={cn(layerClasses(), "block size-full object-cover")}
        />
      ) : null}
      {answer?.kind === "art" && answer.content.kind === "node" ? (
        <Layer>{answer.content.node}</Layer>
      ) : null}
      {answer?.kind === "pending" ? (
        <Pin to="bottom-left" offset="sm" decorative>
          <Loading variant="spinner" label={answer.label} />
        </Pin>
      ) : null}
      {failure !== null ? (
        <Pin to="top-left" offset="sm">
          <Badge
            variant="destructive"
            icon={<Icon icon={errorIcon} />}
            tooltip={`Cover failed — ${failure}`}
            aria-label="Cover failed"
          >
            {/* Icon only: it must fit a list thumbnail as well as a card. */}
            {null}
          </Badge>
        </Pin>
      ) : null}
    </Layer>
  );
}
