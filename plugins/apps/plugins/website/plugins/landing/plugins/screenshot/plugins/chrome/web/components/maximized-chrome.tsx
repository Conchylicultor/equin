import { useMemo, type ReactNode } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { usePageShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { RestoreStrip } from "./demo-controls";
import "./maximized-chrome.css";

/**
 * Esc's precedence: below every other binding of the key (default 0), so it
 * restores only when nothing inside the demo wants Esc.
 */
const RESTORE_PRECEDENCE = -1;

/**
 * What a maximized demo draws over itself, in its own box (a `relative`
 * one): the Restore strip at the top edge, a notice saying Esc restores —
 * shown each time the demo is maximized, gone on its own after a few seconds
 * (as a browser's full-screen notice) — and Esc itself.
 *
 * **Who gets Esc.** The demo's apps use Esc too (close a menu or dialog,
 * leave a field, exit a window's full screen, leave the desktop overview, end
 * a tour), so Restore takes it last: it is a page-wide shortcut of the lowest
 * precedence, under the shortcuts' own rule. It fires only when the key was
 * not handled already (an open menu or dialog closes on it and marks it
 * handled), no text field claims it, and no other Esc shortcut is eligible.
 * So Esc always goes to the innermost thing that wants it, and only an Esc
 * nothing inside wants restores the demo — a second Esc after the one that
 * closed a dialog.
 *
 * `onRestore` is the switch back to the frame (the caller runs it through
 * `morphDemoFrame`, so the demo shrinks back into place).
 */
export function MaximizedChrome({
  onRestore,
}: {
  onRestore: () => void;
}): ReactNode {
  usePageShortcuts(
    useMemo(
      () => [
        {
          id: "demo.restore",
          keys: "Escape",
          label: "Restore the demo",
          group: "Demo",
          precedence: RESTORE_PRECEDENCE,
          handler: onRestore,
        },
      ],
      [onRestore],
    ),
  );
  return (
    <>
      <Pin to="top" offset="lg" decorative layer="overlay">
        <div className="demo-esc-notice" data-demo-esc-notice="" role="status">
          <Text as="p" variant="label" tone="default">
            Press <Kbd>Esc</Kbd> to restore
          </Text>
        </div>
      </Pin>
      <RestoreStrip onRestore={onRestore} />
    </>
  );
}
