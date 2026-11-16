import { useEffect, useRef, useState } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { installOverscrollHint } from "./overscroll-detector";
import { ARC_LENGTH, DISC } from "./pull-refresh";
import { installTouchClaimGuard } from "./touch-claim-guard";

/**
 * Global controller. Mounted once via `Core.Root`, it installs the
 * wasted-scroll detector and the touch-claim guard (a touch drag must declare
 * its `touch-action`, which is how the detector tells it from a wasted scroll)
 * on the window for the lifetime of the app. It draws nothing but the pull to
 * refresh disc, and that only while a pull is on.
 */
export function OverscrollHintController() {
  const [pulling, setPulling] = useState(false);
  const discRef = useRef<HTMLElement>(null);
  useEffect(
    () =>
      installOverscrollHint({
        setShown: setPulling,
        disc: () => discRef.current,
        refresh: () => window.location.reload(),
      }),
    [],
  );
  useEffect(() => installTouchClaimGuard(), []);
  if (!pulling) return null;
  return (
    <ViewportOverlay className="pointer-events-none">
      <Center axis="horizontal">
        <PullRefreshDisc ref={discRef} />
      </Center>
    </ViewportOverlay>
  );
}

/**
 * The pull to refresh disc: a circle dropping from above the top edge, its
 * arc filling with the pull (`--pull-arc-offset`), solid and arrow-headed
 * once armed, spinning while the page reloads. Every per-frame style is written by `pull-refresh`.
 */
function PullRefreshDisc({ ref }: { ref: React.Ref<HTMLElement> }) {
  return (
    <Center
      ref={ref}
      aria-hidden
      className="group rounded-full bg-popover text-primary-text opacity-0 shadow-md ring-1 ring-black/5 data-[armed]:bg-primary data-[armed]:text-primary-foreground data-[spinning]:[&>svg]:animate-spin"
      style={{
        width: DISC,
        height: DISC,
        transform: `translateY(${-DISC - 8}px)`,
      }}
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      >
        <circle
          cx="12"
          cy="12"
          r="7"
          strokeDasharray={ARC_LENGTH}
          transform="rotate(-90 12 12)"
          style={{
            strokeDashoffset: `var(--pull-arc-offset, ${ARC_LENGTH})`,
          }}
        />
        <path
          d="M12 2.6 L15 5 L12 7.4"
          className="opacity-0 group-data-[armed]:opacity-100"
        />
      </svg>
    </Center>
  );
}
