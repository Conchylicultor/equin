import type { ReactNode } from "react";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { WithHoverCard } from "@plugins/primitives/plugins/overlay/plugins/hover-card/web";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { prototypeThumbnailAsset, type ThumbnailState } from "../../core";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");
const downloadingIcon = symbol("downloading");
const computerIcon = symbol("computer");

/**
 * A prototype's rendered preview, for use as a gallery card's cover.
 *
 * Five arms:
 *
 * - rendered → the cached PNG (its bytes loading → the loading state);
 * - not rendered yet (or still rendering) → the caller's `fallback`;
 * - waiting for the browser to install → the `fallback` plus a muted marker;
 * - unavailable (this host has nothing to render with, and nothing cached for
 *   these bytes) → the `fallback` plus a muted "Preview unavailable" marker;
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
 * which arm is true is already known.
 */
export function PrototypeThumbnail({
  state,
  fallback,
}: {
  state: ThumbnailState | undefined;
  fallback: ReactNode;
}) {
  if (state?.status === "ready") {
    return <ReadyThumbnail thumbKey={state.key} fallback={fallback} />;
  }

  if (state?.status === "failed") {
    return <FailedThumbnail message={state.message} fallback={fallback} />;
  }

  if (state?.status === "waiting-for-browser") {
    // Nothing is wrong with the prototype — the browser that renders previews
    // is still installing.
    return (
      <MutedMarker
        fallback={fallback}
        icon={downloadingIcon}
        title="Installing browser"
        message={state.message}
      />
    );
  }

  if (state?.status === "unavailable") {
    // Nothing is wrong with the prototype either — this host (a browser host)
    // has no browser of its own to render it with.
    return (
      <MutedMarker
        fallback={fallback}
        icon={computerIcon}
        title="Preview unavailable"
        message={state.message}
      />
    );
  }

  return <>{fallback}</>;
}

/**
 * The cached PNG, over the subtree's transport (`useAssetSrc`). On the page's
 * own server it is the path itself, synchronously — the same frame as the
 * card. Its bytes still loading is the loading state (a shimmer that shows
 * only on a slow load); a failed load is the failed marker. The route is
 * served on every host, so `unavailable` is only the asset contract's arm,
 * drawn like the state's.
 */
function ReadyThumbnail({
  thumbKey,
  fallback,
}: {
  thumbKey: string;
  fallback: ReactNode;
}) {
  const src = useAssetSrc(prototypeThumbnailAsset(thumbKey));
  if (src.kind === "error") {
    return <FailedThumbnail message={src.message} fallback={fallback} />;
  }
  if (src.kind === "loading") {
    return <Loading variant="block" className="h-full w-full" />;
  }
  if (src.kind === "unavailable") {
    return (
      <MutedMarker
        fallback={fallback}
        icon={computerIcon}
        title="Preview unavailable"
        message={src.message}
      />
    );
  }
  return (
    <img
      src={src.src}
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

/**
 * The `fallback` with a muted marker, its `message` on hover: nothing is wrong
 * with the prototype, the picture is just not here (yet). Same layering as
 * `FailedThumbnail` (see there).
 */
function MutedMarker({
  fallback,
  icon,
  title,
  message,
}: {
  fallback: ReactNode;
  icon: IconRef;
  title: string;
  message: string;
}) {
  return (
    <Overlay behind={fallback} fill className="h-full w-full">
      <Pin to="bottom-right" offset="xs">
        <WithHoverCard card={{ title, description: message }}>
          <Badge variant="muted" icon={<Icon icon={icon} />}>
            {title}
          </Badge>
        </WithHoverCard>
      </Pin>
    </Overlay>
  );
}

/** The `fallback` with a visible "Preview failed" marker, the reason on hover. */
function FailedThumbnail({
  message,
  fallback,
}: {
  message: string;
  fallback: ReactNode;
}) {
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
        <WithHoverCard card={{ title: "Preview failed", description: message }}>
          <Badge variant="warning" icon={<Icon icon={warningIcon} />}>
            Preview failed
          </Badge>
        </WithHoverCard>
      </Pin>
    </Overlay>
  );
}
