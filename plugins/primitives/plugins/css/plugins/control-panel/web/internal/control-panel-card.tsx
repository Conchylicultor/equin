import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SETTINGS_TITLE } from "./settings-picks";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type React from "react";
import { useRef, useState } from "react";

import { ControlPanel } from "./control-panel";
import type {
  ControlPanelAnchoring,
  ControlPanelPositioning,
} from "./control-panel-popover";
import { ControlPanelHostProvider, type ControlPanelHost } from "./host";
import { ControlPanelStack } from "./panel-stack";
import { usePanelStackState } from "./stack-context";

const closeIcon = symbol("close");

export type ControlPanelCardProps = ControlPanelPositioning &
  ControlPanelAnchoring & {
    /**
     * The card's title, drawn in its title row beside the close button — and
     * the panel's accessible name. Required: a settings card is a titled
     * thing, which is what sets it apart from a menu.
     */
    title: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  };

/**
 * The third surface of the vocabulary, beside `ControlPanelPopover` (a menu of
 * choices) and `ControlPanelPane` (a settings pane): a SETTINGS CARD — a
 * titled popover holding settings sections, their prose on the band and their
 * fields spanning the card (an app's own settings under a gear).
 *
 * Like its siblings it takes no width, padding or className. What it owns is
 * exactly what makes it a card rather than a menu, so a call site never picks
 * a look:
 *
 *  - A title row with a close button, above the body and on its rail (not
 *    the popover's sticky `header`, whose rule and inset are a menu's).
 *  - The `settings` width role (density `popoverWidthSettings`) and the card
 *    inset (`settingsCardPad`, via `cp-card`), fixed like a dialog's size.
 *  - The host policy: sections draw a HEADING (`sections: "heading"`) and
 *    descriptions sit on the band, one level of nesting inline.
 *  - Initial focus on the title row when opened by pointer, so no row action
 *    opens ringed; a keyboard open still lands on the first control.
 */
export function ControlPanelCard({
  trigger,
  anchor,
  title,
  align = "start",
  side = "bottom",
  open,
  onOpenChange,
  children,
}: ControlPanelCardProps) {
  const stack = usePanelStackState();
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const headRef = useRef<HTMLElement>(null);
  return (
    <Popover
      open={isOpen}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nowOpen) => {
        if (!nowOpen) stack.reset();
      }}
    >
      {trigger ? <PopoverTrigger render={trigger} /> : null}
      <PopoverContent
        resetOnClose
        anchor={anchor}
        align={align}
        side={side}
        width="settings"
        padding="none"
        className="cp-card"
        initialFocus={(openType) =>
          openType === "keyboard" ? true : headRef.current
        }
      >
        <Stack
          ref={headRef}
          tabIndex={-1}
          data-cp-card-head=""
          direction="row"
          gap="sm"
          align="center"
          className="outline-none"
        >
          <Fill>
            <Text as="h2" pick={SETTINGS_TITLE} step="base">
              {title}
            </Text>
          </Fill>
          <IconButton
            icon={closeIcon}
            label="Close"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground"
          />
        </Stack>
        <ControlPanel aria-label={title}>
          <ControlPanelHostProvider host={CARD_HOST}>
            <ControlPanelStack root={children} state={stack} />
          </ControlPanelHostProvider>
        </ControlPanel>
      </PopoverContent>
    </Popover>
  );
}

const CARD_HOST: ControlPanelHost = {
  nesting: "inline",
  inlineDepth: 1,
  descriptions: "band",
  sections: "heading",
};
