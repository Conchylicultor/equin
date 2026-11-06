import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { PIP_WIDTH } from "../internal/geometry";
import {
  documentPipOf,
  mirrorPageInto,
  pipOffered,
  requestPipWindow,
} from "../internal/document-pip";
import { mediaPlayerThemeScope } from "../internal/theme";
import { createPlayerHost, placeHost, removeHost } from "../internal/media-ops";
import { Player } from "./player";

const pipIcon = symbol("picture-in-picture-alt");

export interface MediaPlayerProps {
  /** A video (controls float over the picture) or audio (the same controls as a bar). */
  kind: "video" | "audio";
  src: string;
  /** What is playing, for assistive tech: the file's or the block's name. */
  label: string;
  /** Start playing on load (a browser that refuses unprompted playback leaves it paused). */
  autoPlay?: boolean;
  /**
   * The media could not be loaded or decoded — the element's `MediaError`.
   * The caller owns what to show instead (and a retry: remount with a new `key`).
   */
  onError?(error: MediaError | null): void;
  /** Sizing for the player's box (`max-h-full`, a width): it lands on the player's root. */
  className?: string;
}

/**
 * A themed player in place of the browser's native one — see the plugin's
 * CLAUDE.md for the whole design.
 *
 * The player renders through a portal into a host element this component
 * owns. On the page the host sits where the player is; for picture in
 * picture the host — the same DOM, the same `<video>` still playing, every
 * React listener with it (React listens on the portal's container) — moves
 * into a Document Picture-in-Picture window, and the page keeps a
 * placeholder with "Bring back". Where the browser has no such window or
 * refuses it, the video's own picture in picture is used instead.
 */
export function MediaPlayer({
  kind,
  src,
  label,
  autoPlay = false,
  onError,
  className,
}: MediaPlayerProps) {
  const [host] = useState(createPlayerHost);
  const slotRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [win, setWin] = useState<Window | null>(null);
  const [holder, setHolder] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [offered] = useState(() => pipOffered(window));

  // The host lives in the slot while the player is on the page.
  useLayoutEffect(() => {
    placeHost(slotRef.current, host);
    return () => removeHost(host);
  }, [host]);

  // Leaving the page closes our window: the player goes with this component.
  useEffect(() => () => win?.close(), [win]);

  const openOwnWindow = (w: Window, root: HTMLElement) => {
    const r = root.getBoundingClientRect();
    const dispose = mirrorPageInto(document, w.document);
    setHolder({ width: r.width, height: r.height });
    // Moved, not copied: the same <video> keeps playing.
    placeHost(w.document.body, host);
    setWin(w);
    root.focus({ preventScroll: true });
    w.addEventListener(
      "pagehide",
      () => {
        dispose();
        placeHost(slotRef.current, host);
        setWin(null);
      },
      { once: true },
    );
  };

  // A request in flight: a second press (P twice) must not ask for a second
  // window while the browser is still answering the first.
  const requesting = useRef(false);

  const toggle = useEventCallback(async () => {
    if (requesting.current) return;
    if (win) {
      win.close();
      return;
    }
    const media = mediaRef.current;
    // Only THIS player's video leaves the browser's picture in picture: the
    // page has one, and another player's may be in it.
    if (media !== null && document.pictureInPictureElement === media) {
      await document.exitPictureInPicture();
      return;
    }
    requesting.current = true;
    try {
      await enterPip(media);
    } finally {
      requesting.current = false;
    }
  });

  const enterPip = async (media: HTMLMediaElement | null) => {
    const root = rootRef.current;
    const api = documentPipOf(window);
    if (api && root) {
      const r = root.getBoundingClientRect();
      const w = await requestPipWindow(api, {
        width: PIP_WIDTH,
        height: Math.round((PIP_WIDTH * r.height) / Math.max(1, r.width)),
      });
      if (w) {
        openOwnWindow(w, root);
        return;
      }
    }
    if (media instanceof HTMLVideoElement)
      await media.requestPictureInPicture();
  };

  return (
    <>
      <div ref={slotRef} className="mp-slot" />
      {win !== null && (
        <Theme
          name={mediaPlayerThemeScope}
          surface="none"
          className="mp-pip-holder bg-card"
          style={holder}
        >
          <Icon icon={pipIcon} />
          <Text variant="body">Playing in picture in picture</Text>
          <ControlSizeProvider size="sm">
            <Button
              variant="secondary"
              shape="pill"
              onClick={() => win.close()}
            >
              Bring back
            </Button>
          </ControlSizeProvider>
        </Theme>
      )}
      {createPortal(
        <Player
          rootRef={(r) => {
            rootRef.current = r;
          }}
          kind={kind}
          src={src}
          label={label}
          autoPlay={autoPlay}
          onError={onError}
          className={className}
          pip={
            kind === "video" && offered
              ? { open: win !== null, toggle: () => void toggle() }
              : null
          }
          mediaRef={(m) => {
            mediaRef.current = m;
          }}
        />,
        host,
      )}
    </>
  );
}
