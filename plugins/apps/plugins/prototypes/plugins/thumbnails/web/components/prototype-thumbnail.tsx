import type { ReactNode } from "react";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { WithHoverCard } from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import { prototypeThumbnailUrl, type ThumbnailState } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");
const downloadingIcon = symbol("downloading");

/**
 * A prototype's rendered preview, for use as a gallery card's cover.
 *
 * Four arms:
 *
 * - rendered → the cached PNG;
 * - not rendered yet (or still rendering) → the caller's `fallback`;
 * - waiting for the browser to install → the `fallback` plus a muted marker;
 * - failed → the `fallback` plus a visible marker saying so, with the reason on
 *   hover. Nothing was cached, so the next edit retries on its own.
 *
 * The `fallback` is the caller's art, not this plugin's: the gallery already
 * owns a cover for a prototype with no picture, and there is no reason for two
 * plugins to have an opinion about what that looks like.
 *
 * It takes the `state`, it does not fetch it — see `usePrototypeThumbnails`.
 * A cover with no pending arm cannot paint a stand-in and then swap in a
 * picture, so the flicker has nowhere left to live: by the time this renders,
 * which of the three arms is true is already known.
 */
export function PrototypeThumbnail({
  state,
  fallback,
}: {
  state: ThumbnailState | undefined;
  fallback: ReactNode;
}) {
  if (state?.status === "ready") {
    return (
      <img
        src={prototypeThumbnailUrl(state.key)}
        alt=""
        // The URL carries the content fingerprint and is served `immutable`, so
        // a revisit is a cache hit. `sync` decoding is what turns that hit into
        // the SAME frame as the card: left to decode asynchronously, an
        // already-downloaded picture still lands a frame or two later, which on
        // a grid of cards reads as the covers popping in one by one.
        decoding="sync"
        className="h-full w-full object-cover"
      />
    );
  }

  if (state?.status === "failed") {
    return (
      // Two non-obvious choices, both load-bearing:
      //
      // `behind`, not `above`: an `above` layer is click-through by design,
      // which would swallow the hover the marker's hover card needs.
      //
      // `fill`: without it the children wrapper is in-flow, and a wrapper whose
      // only child is absolutely positioned collapses to zero height — so the
      // marker pins to the TOP edge of a zero-height box and lands above the
      // card, present in the DOM and invisible on screen.
      <Overlay behind={fallback} fill className="h-full w-full">
        <Pin to="bottom-right" offset="xs">
          <WithHoverCard
            card={{ title: "Preview failed", description: state.message }}
          >
            <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
              Preview failed
            </Badge>
          </WithHoverCard>
        </Pin>
      </Overlay>
    );
  }

  if (state?.status === "waiting-for-browser") {
    // Same layering as `failed` below, but muted: nothing is wrong with the
    // prototype — the browser that renders previews is still installing.
    return (
      <Overlay behind={fallback} fill className="h-full w-full">
        <Pin to="bottom-right" offset="xs">
          <WithHoverCard
            card={{ title: "Installing browser", description: state.message }}
          >
            <Badge variant="muted" icon={<Icon icon={downloadingIcon} />}>
              Installing browser
            </Badge>
          </WithHoverCard>
        </Pin>
      </Overlay>
    );
  }

  return <>{fallback}</>;
}
