import type { ReactNode } from "react";
import { Movable } from "@plugins/primitives/plugins/dom/plugins/movable/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import "./back-to-site-pill.css";

/**
 * The way back from the demo page to the homepage it was maximized from: a
 * small pill hanging from the top edge, centred — between the demo's own
 * launcher (top-left) and the page's floating action bar (top-right) — that
 * says what this is ("Demo · made-up data") and offers Back to equin. Always
 * shown, never on hover, so a touch screen has it too; on a narrow screen
 * only the button stays. The visitor can drag it off whatever it covers
 * (`Movable`, inside `bounds`); a double-click sends it home.
 *
 * `onBack` is the switch back to the frame (the caller runs it through
 * `morphDemoFrame`, so the demo shrinks back into place).
 */
export function BackToSitePill({
  onBack,
  bounds,
}: {
  onBack: () => void;
  /** The box the pill stays inside: the demo page's. */
  bounds: HTMLElement | null;
}): ReactNode {
  return (
    <Movable
      at={{ pin: "top", offset: "sm", layer: "overlay" }}
      bounds={bounds}
      className="demo-back-pill"
      data-demo-back=""
    >
      <Text
        as="span"
        variant="label"
        tone="muted"
        className="demo-back-pill-what"
      >
        Demo · made-up data
      </Text>
      <Button variant="ghost" onClick={onBack}>
        <Icon icon={symbol("arrow-back")} />
        Back to equin
      </Button>
    </Movable>
  );
}
