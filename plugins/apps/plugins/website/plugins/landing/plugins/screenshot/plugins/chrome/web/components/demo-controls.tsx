import type { ReactNode } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { useDemoHostControl } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { useConfirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";

/**
 * The way back to the frame, maximized: hidden until the pointer reaches the
 * page's top edge (a thin strip at its centre — as a full-screen window's
 * menu bar shows), or keyboard focus does. The top corners are the app's own
 * (its launcher) and the floating action bar's.
 */
export function RestoreStrip({
  onRestore,
}: {
  onRestore: () => void;
}): ReactNode {
  const { revealed, groupProps } = useHoverReveal();
  return (
    <Pin to="top" offset="none">
      <div
        {...groupProps}
        data-demo-restore=""
        // eslint-disable-next-line layout/no-adhoc-layout -- the hover strip: only its own thin band is a target until it reveals the button
        className={cn("flex justify-center px-xl", revealed ? "py-sm" : "h-2")}
      >
        <Button
          variant="floating"
          className={hoverRevealClass(revealed)}
          onClick={onRestore}
        >
          <Icon icon={symbol("fullscreen-exit")} />
          Restore
        </Button>
      </div>
    </Pin>
  );
}

/**
 * Reset: the demo keeps what the visitor does (in this browser, across reloads
 * and tabs) until they ask for the story back — every open tab of the demo
 * starts again from it. `onReset` runs first, before the host reboots and the
 * demo remounts: a page keeping the demo's location sends it back to the
 * start there, since where the visitor was may be something the reset erased.
 */
export function ResetDemoButton({
  onReset,
}: {
  onReset?: () => void;
}): ReactNode {
  const confirmDialog = useConfirmDialog();
  const { reset } = useDemoHostControl();
  return (
    <Button
      variant="outline"
      onClick={() => {
        void confirmDialog({
          title: "Reset the demo?",
          description:
            "Everything you changed in the demo is erased, and it starts again from its story — in every tab it is open in.",
          confirmLabel: "Reset demo",
          onConfirm: () => {
            onReset?.();
            return reset();
          },
        });
      }}
    >
      Reset demo
    </Button>
  );
}
