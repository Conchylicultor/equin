import { useLayoutEffect, useState, type RefObject } from "react";

import { afterLayout } from "@plugins/primitives/plugins/dom/plugins/after-layout/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

import { flowAxis, layoutHost, type FlowAxis } from "./layout-host";

/**
 * The axis the box laying `sentinel` out flows its children along — read in
 * the frame's after-layout phase (`dom/after-layout`), where computed style is
 * already resolved, and committed before paint. `"column"` until then (never
 * painted: the phase runs before the first paint).
 *
 * Read once per mount. `followResize: true` also follows the host's resizes
 * (a breakpoint flipping it from a column to a row resizes it too).
 *
 * This is the only way to read a host's axis: the `getComputedStyle` walk
 * behind it, called on React's commit path, forced a full-document style
 * recalc per slot mounted right after a large style change.
 */
export function useHostFlowAxis(
  sentinel: RefObject<Element | null>,
  options?: { followResize?: boolean },
): FlowAxis {
  const followResize = options?.followResize === true;
  const [axis, setAxis] = useState<FlowAxis>("column");
  const [host, setHost] = useState<Element | null>(null);

  useLayoutEffect(
    () =>
      afterLayout(() => {
        const node = sentinel.current;
        const found = node ? layoutHost(node) : null;
        if (!found) return;
        setAxis(flowAxis(found));
        if (followResize) setHost(found);
      }),
    [sentinel, followResize],
  );

  useResizeObserver(
    () => host,
    () => {
      if (host) setAxis(flowAxis(host));
    },
    { deps: [host] },
  );

  return axis;
}
