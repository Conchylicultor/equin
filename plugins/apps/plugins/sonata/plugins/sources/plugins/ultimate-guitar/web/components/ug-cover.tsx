import { useState, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Layer,
  layerClasses,
} from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { coverDetailClass } from "@plugins/primitives/plugins/data-view/web";
import { exposedColumns } from "@plugins/network/plugins/live/core";
import { youtubeThumbnailUrl } from "@plugins/integrations/plugins/youtube/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Song } from "@plugins/apps/plugins/sonata/plugins/library/core";
import type { SongCoverAnswer } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import { ugAlignmentShape } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core";
import { ultimateGuitarShape } from "../../core";

const ugColumns = exposedColumns(ultimateGuitarShape.exposure);
const alignmentColumns = exposedColumns(ugAlignmentShape.exposure);

const playIcon = symbol("play-arrow");
const sheetIcon = symbol("article");
const errorIcon = symbol("error");

/**
 * The Ultimate Guitar song's cover (`Library.Cover`), read from the listed row
 * alone — the tab's key (the UG exposure) and the recording's video id (this
 * plugin's exposure), both under the row's `$columns`. Hook-free: the library
 * calls it per card per render.
 *
 * - a video → its YouTube thumbnail filling the cover, a small "Key X" badge
 *   bottom-left (none when the tab has no key);
 * - no video (yet) → the chord-sheet cover: the sheet glyph over a large faint
 *   key watermark — never made-up chords.
 *
 * Any other source's song → `undefined` (not ours to answer).
 */
export function ugCover(song: Song): SongCoverAnswer | undefined {
  if (song.source !== UG_SOURCE_ID) return undefined;
  const { key } = ugColumns.read(song);
  const { videoId } = alignmentColumns.read(song);
  return {
    kind: "art",
    content: {
      kind: "node",
      node:
        videoId === null ? (
          <UgSheetCover keyName={key} />
        ) : (
          <UgVideoCover videoId={videoId} keyName={key} />
        ),
    },
  };
}

interface UgVideoCoverProps {
  videoId: string;
  /** The tab's key; null → no badge. */
  keyName: string | null;
}

/** The recording's thumbnail, object-cover, with the key badge. A thumbnail
 *  that fails to load falls back to the sheet cover with a visible failure. */
export function UgVideoCover({
  videoId,
  keyName,
}: UgVideoCoverProps): ReactNode {
  const src = youtubeThumbnailUrl(videoId, "mq");
  // Keyed by URL: another video tries again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) {
    return (
      <>
        <UgSheetCover keyName={keyName} />
        <Pin to="top-left" offset="sm">
          <Badge
            variant="destructive"
            icon={<Icon icon={errorIcon} />}
            tooltip={`The video thumbnail did not load (${src}).`}
          >
            Thumbnail failed
          </Badge>
        </Pin>
      </>
    );
  }
  return (
    <>
      <img
        src={src}
        alt=""
        decoding="async"
        loading="lazy"
        draggable={false}
        onError={() => setFailedSrc(src)}
        className={cn(layerClasses(), "block size-full object-cover")}
      />
      {keyName === null ? null : (
        // On the float glass, so the key reads over any thumbnail.
        <Pin
          to="bottom-left"
          offset="sm"
          decorative
          className={coverDetailClass}
        >
          <Surface level="float">
            <Badge icon={<Icon icon={playIcon} />}>{`Key ${keyName}`}</Badge>
          </Surface>
        </Pin>
      )}
    </>
  );
}

/** The no-video cover: the sheet glyph on the muted surface, the key as a
 *  large faint watermark bottom-right (absent when the tab has no key). */
export function UgSheetCover({
  keyName,
}: {
  keyName: string | null;
}): ReactNode {
  return (
    <Layer className="bg-muted text-muted-foreground">
      {keyName === null ? null : (
        <svg
          aria-hidden
          viewBox="0 0 160 100"
          preserveAspectRatio="xMidYMid slice"
          className={cn(layerClasses(), "size-full")}
        >
          <text
            x={148}
            y={88}
            textAnchor="end"
            fontSize={58}
            fontWeight={800}
            fill="currentColor"
            opacity={0.12}
          >
            {keyName}
          </text>
        </svg>
      )}
      <Center className="size-full">
        <Icon
          icon={sheetIcon}
          className="size-[30%] max-h-10 max-w-10 opacity-80"
        />
      </Center>
    </Layer>
  );
}
