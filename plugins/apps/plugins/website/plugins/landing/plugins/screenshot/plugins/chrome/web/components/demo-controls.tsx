import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useDemoHostControl } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { useConfirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";

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
