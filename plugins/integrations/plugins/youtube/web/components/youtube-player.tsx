import { useEffect, useRef, useState } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Layer,
  layerClasses,
} from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  hoverRevealGroup,
  hoverRevealTargetWithGroupFocus,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { youtubeThumbnailUrl, youtubeWatchUrl } from "../../core";
import {
  YouTubePlayerControllerImpl,
  type YouTubePlayerCallbacks,
  type YouTubeAudio,
  type YouTubePlayerController,
  type YouTubeRange,
} from "../internal/controller";
import { useYouTubePlayerState } from "../internal/hooks";
import { loadYouTubeIframeApi } from "../internal/iframe-api";

export interface YouTubePlayerProps extends YouTubePlayerCallbacks {
  /** From `useYouTubePlayer()`; one controller binds to one mounted player. */
  controller: YouTubePlayerController;
  videoId: string;
  /**
   * The stretch to repeat, in seconds, or `null` to play straight through.
   * Changing it on the same video moves the loop without reloading.
   */
  loop: YouTubeRange | null;
  /**
   * Start each newly loaded video by itself (browsers allow this once the page
   * has been interacted with). Otherwise a new video is cued at the loop start
   * and waits for `controller.play()`. Read when a video loads.
   */
  autoplay?: boolean;
  /**
   * The volume (0–100) and mute to hold the player at, on this video and every
   * one loaded after. Muting does not pause: the video keeps playing silently.
   * Omitted leaves the audio as YouTube has it.
   */
  audio?: YouTubeAudio;
  /**
   * Show YouTube's own control bar (play, seek, volume), for a video the viewer
   * plays by hand. Off by default: the app owns the transport, so the iframe
   * takes no pointer at all and the video's thumbnail covers it while it is
   * not playing — so YouTube's chrome (title, channel, share, watch later,
   * logo, play button) never shows — and a click on the video opens it on
   * youtube.com, in a new tab, where it is now. Read when the
   * player is created — changing it re-creates the player.
   */
  controls?: boolean;
  className?: string;
}

/**
 * An embedded YouTube player bound to `controller`. The iframe fills this
 * element; giving it a size (a 16:9 box) is the caller's job.
 *
 * The player is created once per mount and reused across `videoId` changes
 * (loaded or cued in place), and destroyed on unmount. A failure to load the
 * IFrame API script is thrown during render, to the nearest error boundary.
 */
export function YouTubePlayer({
  controller,
  videoId,
  loop,
  autoplay = false,
  audio,
  controls = false,
  className,
  onReady,
  onPlaying,
  onError,
  onStateChange,
}: YouTubePlayerProps) {
  const impl = asImpl(controller);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const callbacks = useLatestRef<YouTubePlayerCallbacks>({
    onReady,
    onPlaying,
    onError,
    onStateChange,
  });

  const loopStart = loop?.start ?? null;
  const loopEnd = loop?.end ?? null;
  const volume = audio?.volume ?? null;
  const muted = audio?.muted ?? null;
  useEffect(() => {
    impl.setSource({
      videoId,
      loop:
        loopStart === null || loopEnd === null
          ? null
          : { start: loopStart, end: loopEnd },
      autoplay,
      audio: volume === null || muted === null ? null : { volume, muted },
    });
  }, [impl, videoId, loopStart, loopEnd, autoplay, volume, muted]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) throw new Error("YouTubePlayer: host element missing");
    impl.setCallbacks(() => callbacks.current);
    // The API replaces the element it is given with its iframe, so it gets a
    // node React does not own.
    const mount = document.createElement("div");
    host.appendChild(mount);
    let cancelled = false;
    void loadYouTubeIframeApi().then(
      (yt) => {
        if (!cancelled) impl.attach(yt, mount, { controls });
      },
      (err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
    return () => {
      cancelled = true;
      impl.detach();
      host.replaceChildren();
    };
  }, [impl, callbacks, controls]);

  if (loadError !== null) throw loadError;

  return (
    <div className={cn("relative size-full", className)}>
      <div ref={hostRef} className="size-full" />
      {!controls && <OpenOnYouTube controller={impl} videoId={videoId} />}
    </div>
  );
}

/**
 * A shield over an app-driven player: it keeps the pointer off the iframe (so
 * YouTube draws none of its hover chrome) and is itself a link to the video on
 * youtube.com — a real link, so a middle- or cmd-click works too. The link
 * starts where the video is: the playhead is read on press, which React
 * flushes before the click that follows it.
 *
 * While the video is not playing (loading, cued, paused) the video's own
 * thumbnail covers the iframe: that is when YouTube paints its title, channel,
 * share / watch-later buttons and big play button, none of which this app can
 * use. Hovering dims the picture and names where a click goes.
 */
function OpenOnYouTube({
  controller,
  videoId,
}: {
  controller: YouTubePlayerControllerImpl;
  videoId: string;
}) {
  const state = useYouTubePlayerState(controller);
  const playing = state.kind === "ready" && state.playing;
  const [at, setAt] = useState<number | null>(null);
  const readPlayhead = () =>
    setAt(
      controller.getSnapshot().kind === "ready"
        ? controller.getCurrentTime()
        : null,
    );
  return (
    <a
      href={youtubeWatchUrl(videoId, at)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open on YouTube"
      className={cn(
        layerClasses(),
        hoverRevealGroup,
        "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      )}
      onPointerDown={readPlayhead}
      onKeyDown={readPlayhead}
    >
      <img
        src={youtubeThumbnailUrl(videoId)}
        alt=""
        draggable={false}
        className={cn(
          layerClasses({ decorative: true }),
          "size-full object-cover transition-opacity duration-300",
          playing ? "opacity-0" : "opacity-100",
        )}
      />
      {/* The link is the trigger, so its focus reveals the hint too. */}
      <Layer className={cn(hoverRevealTargetWithGroupFocus, "bg-black/45")}>
        <Center className="size-full">
          <Line className="gap-2xs rounded-full bg-black/70 px-sm py-2xs text-white">
            <Icon icon={navIcons.newTab} />
            <Text variant="caption" className="font-medium text-white">
              Open on YouTube
            </Text>
          </Line>
        </Center>
      </Layer>
    </a>
  );
}

function asImpl(
  controller: YouTubePlayerController,
): YouTubePlayerControllerImpl {
  if (!(controller instanceof YouTubePlayerControllerImpl)) {
    throw new Error(
      "YouTubePlayer: controller must come from useYouTubePlayer()",
    );
  }
  return controller;
}
