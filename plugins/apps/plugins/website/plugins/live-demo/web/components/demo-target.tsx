import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { EmbedPlaceBinding } from "@plugins/apps-core/plugins/app-embed/web";
import {
  DEMO_FRAME_ATTR,
  DemoBootScreen,
} from "@plugins/apps/plugins/website/plugins/landing/plugins/screenshot/plugins/chrome/web";
import {
  useDemoActions,
  useDemoState,
  type DemoTargetKind,
} from "../internal/demo-store";

/**
 * The box a page draws the live demo in: it claims the demo when it mounts —
 * the resident (`DemoResident`, in the site's surface) draws the demo's boot
 * screen and then the running demo into it, through a portal — and gives it
 * back when it unmounts; the demo's server keeps running meanwhile. The claim
 * is a layout effect, so a page switch run inside the Maximize / Restore
 * morph (`flushSync`) has the new box before the transition's snapshot. It is
 * the demo's box for that morph (`DEMO_FRAME_ATTR`).
 *
 * `kind` says which page it is: `framed` (the homepage's band — the place
 * kept in memory) or `page` (the demo page, whose place is its URL: `place`).
 * Until the resident fills it (a static render: the crawlable snapshot) it
 * shows the boot screen's first state.
 */
export function DemoTarget({
  kind,
  place,
  className,
  style,
}: {
  kind: DemoTargetKind;
  /** The page's own place binding (the demo page's embed tail); the frame's is memory. */
  place?: EmbedPlaceBinding;
  className?: string;
  style?: CSSProperties;
}): ReactNode {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const { target } = useDemoState();
  const demo = useDemoActions();
  useLayoutEffect(
    () => (element === null ? undefined : demo.claimTarget(kind, element)),
    [demo, kind, element],
  );
  useLayoutEffect(() => {
    if (element !== null) demo.bindTargetPlace(element, place ?? null);
  }, [demo, element, place, target]);
  const claimed = element !== null && target?.element === element;
  return (
    <div
      ref={setElement}
      {...{ [DEMO_FRAME_ATTR]: "" }}
      // Which page's box it is, for a reader outside (an e2e script).
      data-demo-target={kind}
      className={className}
      style={style}
    >
      {!claimed && <DemoBootScreen state={{ kind: "checking" }} />}
    </div>
  );
}

/** Where the framed demo's controls (Maximize, Reset demo) land once it runs. */
export function DemoControls({ className }: { className?: string }): ReactNode {
  const { setControls } = useDemoActions();
  return <span ref={setControls} className={className} />;
}
