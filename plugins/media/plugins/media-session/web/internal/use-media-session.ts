import { useEffect, useState } from "react";
import type { AssetPath } from "@plugins/infra/plugins/endpoints/core";
import { useAssetSrcs } from "@plugins/infra/plugins/endpoints/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  dropClaim,
  setClaim,
  type MediaPosition,
  type MediaSessionActions,
} from "./registry";

/** One picture of what plays, as an asset the page's transport serves. */
export interface MediaArtwork {
  readonly asset: AssetPath;
  /** The image's size, as the Media Session spec spells it ("512x512"). */
  readonly sizes: string;
  /** Its MIME type ("image/png"). */
  readonly type: string;
}

/** What a player tells the browser about the music it plays. */
export interface MediaSessionClaim {
  readonly title: string;
  readonly artist?: string;
  readonly album?: string;
  readonly artwork?: readonly MediaArtwork[];
  /** Whether it sounds now. Paused, it keeps the session (the browser shows ▶). */
  readonly playing: boolean;
  /** Where playback is in the whole (a scrubber); omitted: no scrubber. */
  readonly position?: MediaPosition;
  /** What the browser's controls and the OS media keys ask of it. */
  readonly actions: MediaSessionActions;
}

const NO_ARTWORK: readonly MediaArtwork[] = [];

/**
 * Puts the caller's music in the browser's media session — Chrome's media
 * controls, the OS's Now Playing and media keys — for music that plays through
 * Web Audio (a real `<audio>` / `<video>` element is listed by the browser on
 * its own). `null`: nothing to claim now.
 *
 * The page has one session: the claim that most recently started playing owns
 * it (a claim that never played does not), and when it goes the previous one
 * takes it back. Actions always reach the latest `actions` passed.
 */
export function useMediaSession(claim: MediaSessionClaim | null): void {
  const [key] = useState(() => Symbol("media-session"));
  const artwork = claim?.artwork ?? NO_ARTWORK;
  const srcs = useAssetSrcs(artwork.map((a) => a.asset));
  const actionsRef = useLatestRef(claim?.actions);

  const images: MediaImage[] = [];
  srcs.forEach((src, i) => {
    const art = artwork[i];
    if (src.kind === "ready" && art !== undefined) {
      images.push({ src: src.src, sizes: art.sizes, type: art.type });
    }
  });
  const active = claim !== null;
  const title = claim?.title ?? "";
  const artist = claim?.artist ?? "";
  const album = claim?.album ?? "";
  const playing = claim?.playing ?? false;
  const duration = claim?.position?.duration;
  const position = claim?.position?.position;
  const imagesKey = JSON.stringify(images);
  // The optional actions offered, as one dependency string.
  const offersKey = OPTIONAL_ACTIONS.filter(
    (a) => claim?.actions[a] !== undefined,
  ).join();

  useEffect(() => {
    if (!active) {
      setClaim(key, null);
      return;
    }
    const offered = new Set(offersKey.split(","));
    const latest = () => actionsRef.current;
    setClaim(key, {
      title,
      artist,
      album,
      artwork: JSON.parse(imagesKey) as MediaImage[],
      playing,
      position:
        duration === undefined || position === undefined
          ? null
          : { duration, position },
      actions: {
        play: () => latest()?.play(),
        pause: () => latest()?.pause(),
        stop: offered.has("stop") ? () => latest()?.stop?.() : undefined,
        seekto: offered.has("seekto")
          ? (seconds) => latest()?.seekto?.(seconds)
          : undefined,
        seekbackward: offered.has("seekbackward")
          ? (offset) => latest()?.seekbackward?.(offset)
          : undefined,
        seekforward: offered.has("seekforward")
          ? (offset) => latest()?.seekforward?.(offset)
          : undefined,
      },
    });
  }, [
    key,
    active,
    title,
    artist,
    album,
    imagesKey,
    playing,
    duration,
    position,
    offersKey,
    actionsRef,
  ]);

  useEffect(() => () => dropClaim(key), [key]);
}

const OPTIONAL_ACTIONS = [
  "stop",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;
