import { useMemo, type ReactNode } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSection,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import {
  usePrototypeDetail,
  type CanvasFrame,
  type FrameActionRow,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { BrowserTabOpener } from "./frame-link";
import type { PresentPlacement } from "./present-overlay";
import { usePresentation } from "./presentation";
import { type IconRef, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { NewTabMenuItem } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

const fullscreenIcon = symbol("fullscreen");
const tabIcon = symbol("tab");
const webAssetIcon = symbol("web-asset");

/**
 * "Present" — one frame's menu of the ways to see it without the app around
 * it, ordered by how much they cover: this app tab, this browser tab (with a
 * new-browser-tab icon), and full screen (`F`).
 *
 * A frame action (`PrototypeFrameActions`) on each canvas frame, so this whole
 * feature is one folder the canvas knows nothing about. The menu of the
 * SELECTED frame also owns the `F` key, so `F` presents the selected frame.
 */
export function PresentMenu({ row }: ItemActionProps<FrameActionRow>) {
  const { frame, meta } = row;
  const { canvas, dispatch } = usePrototypeDetail();
  const { presenting, present: open } = usePresentation();
  // Presenting selects the frame, as clicking it would — so while this frame
  // is on show, this menu is the one holding `F` (and it stands down, below).
  const present = useEventCallback((where: PresentPlacement) => {
    dispatch({ type: "select", id: frame.id });
    open(frame.id, where);
  });

  const holdsF = canvas.selected === frame.id && presenting === null;
  const fullScreenKey = useMemo(
    () =>
      holdsF
        ? [
            {
              id: "prototypes.present-full-screen",
              keys: "f",
              label: "Present the selected frame in full screen",
              group: "Prototypes",
              handler: () => present("screen"),
            },
          ]
        : [],
    [holdsF, present],
  );
  useSurfaceShortcuts(fullScreenKey);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              aspect="icon"
              aria-label="Present"
              tooltip="Present"
            />
          }
        >
          <Icon icon={fullscreenIcon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSection label="Present">
            <PresentRow
              icon={tabIcon}
              label="In this app tab"
              hint="The tab bar stays, so you can switch tabs."
              onClick={() => present("surface")}
            />
            <PresentRow
              icon={webAssetIcon}
              label="In this browser tab"
              hint="Nothing but the frame."
              onClick={() => present("viewport")}
              newTab={<NewBrowserTabItem frame={frame} meta={meta} />}
            />
            <PresentRow
              icon={fullscreenIcon}
              label="Full screen"
              shortcut="F"
              onClick={() => present("screen")}
            />
          </DropdownMenuSection>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * One destination: icon, label and the muted line saying what it covers, with
 * an optional trailing "open it in a new tab" item beside it.
 */
function PresentRow({
  icon,
  label,
  hint,
  shortcut,
  onClick,
  newTab,
}: {
  icon: IconRef;
  label: string;
  hint?: string;
  shortcut?: string;
  /** `undefined` when there is nothing to open: the row shows disabled. */
  onClick: (() => void) | undefined;
  newTab?: ReactNode;
}) {
  return (
    <Stack direction="row" gap="2xs" align="center">
      <DropdownMenuItem
        onClick={onClick}
        disabled={onClick === undefined}
        className={fillClasses("x")}
      >
        <Icon icon={icon} className="size-4 text-muted-foreground" />
        <Stack gap="none" className={fillClasses("x")}>
          <Text>{label}</Text>
          {hint !== undefined ? (
            <Text variant="caption" tone="muted">
              {hint}
            </Text>
          ) : null}
        </Stack>
        {shortcut !== undefined ? <Kbd>{shortcut}</Kbd> : null}
      </DropdownMenuItem>
      {newTab}
    </Stack>
  );
}

/**
 * A new browser tab: a prototype frame opens the app's own present page,
 * chromeless (`?embed=1`) — the same stage, options pill included; a source
 * frame opens what it shows on its own (its `href`), when it has one.
 */
function NewBrowserTabItem({
  frame,
  meta,
}: {
  frame: CanvasFrame;
  meta: PrototypeMeta;
}) {
  return (
    <BrowserTabOpener frame={frame} meta={meta}>
      {(href) => (
        <NewTabMenuItem
          href={href}
          label="Open in a new browser tab"
          unavailableReason="not available for this frame"
          className="w-auto"
        />
      )}
    </BrowserTabOpener>
  );
}
