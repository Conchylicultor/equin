import { useState, type ReactElement, type ReactNode } from "react";

import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { SwitchIndicator } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Button,
  ControlSizeProvider,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SIZE_PRESETS } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasSize } from "../internal/canvas-model";
import {
  MAX_WIDTH,
  MAX_ZOOM,
  MIN_WIDTH,
  MIN_ZOOM,
  sizeForWidth,
  zoomFromPercent,
  type FrameLayout,
} from "../internal/layout";
import { usePrototypeDetail } from "../context";
import { useWindowSize } from "../internal/use-window-size";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const checkIcon = symbol("check");
const computerIcon = symbol("computer");
const desktopWindowsIcon = symbol("desktop-windows");
const descriptionIcon = symbol("description");
const laptopMacIcon = symbol("laptop-mac");
const phoneIphoneIcon = symbol("phone-iphone");
const removeIcon = symbol("remove");
const swapHorizIcon = symbol("swap-horiz");
const tabletMacIcon = symbol("tablet-mac");
const webAssetIcon = symbol("web-asset");

/** The `×` between a width and a height, set off by thin spaces. */
const TIMES = " × ";

/** How far one press of the Size popover's − / + moves the zoom, in percent. */
const ZOOM_STEP = 10;

interface SizeChipProps {
  /**
   * What the canvas computed — the logical size and scale the dock reports.
   * Handed in rather than recomputed so the dock and the frames can never
   * disagree.
   */
  layout: FrameLayout;
  /**
   * Whole page is on but no frame has a page to show — each sizes itself to
   * its window — so the switch reads off, disabled, with the reason in its
   * label.
   */
  noWholePage: boolean;
}

/**
 * The canvas's bottom dock, pinned centred 12px above the canvas's bottom
 * edge. Fixed, not draggable: it is small and centred, so it covers little,
 * and the board leaves room under the frames for it.
 */
export function SizeDock(props: SizeChipProps): ReactElement {
  return (
    <Pin to="bottom" offset="md" className="max-w-[calc(100%-24px)]">
      <SizeChip {...props} />
    </Pin>
  );
}

/**
 * Size, zoom and Whole page for the whole canvas, as ONE glass dock: three
 * device buttons (Responsive, This window, Phone — the current one lit), and
 * the size button (`838 × 724`, then the zoom only while the frames are shown
 * scaled down) opening the Size popover above it — every size, a Width slider
 * for any width between them (snapping onto a preset), the zoom (Fit, − / +, a
 * 10–200% slider with a detent at 100%, and the readout that jumps to actual
 * size) and the Whole page switch. Every frame follows it.
 *
 * Unpositioned: the canvas pins it (`SizeDock`); Present floats it in its own
 * movable chrome.
 */
export function SizeChip({ layout, noWholePage }: SizeChipProps): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const { size } = canvas;
  // The popover's anchor: the dock itself, so the popover's right edge is the
  // dock's and it opens 10px above it.
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const percent = Math.round(layout.scale * 100);
  const setSize = (next: CanvasSize) =>
    dispatch({ type: "setSize", size: next });

  return (
    <ControlSizeProvider size="sm">
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.dock` padding (5px), off the ramp */}
      <Surface level="float" ref={setDock} className="p-[5px]">
        <Stack direction="row" gap="xs" align="center">
          {/* The mockup's `.devs`: 1px between the buttons. */}
          <Stack direction="row" gap="none" className="gap-px">
            <DeviceButton
              icon={swapHorizIcon}
              label="Responsive"
              tooltip="Responsive — fills the canvas"
              on={size.kind === "responsive"}
              onClick={() => setSize({ kind: "responsive" })}
            />
            <DeviceButton
              icon={webAssetIcon}
              label="This window"
              on={size.kind === "window"}
              onClick={() => setSize({ kind: "window" })}
            />
            <DeviceButton
              icon={phoneIphoneIcon}
              label="Phone"
              on={size.kind === "preset" && size.preset === "Phone"}
              onClick={() => setSize({ kind: "preset", preset: "Phone" })}
            />
          </Stack>
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.vdiv` (an 18px rule, 4px either side), off the ramp */}
          <span aria-hidden className="mx-[4px] h-[18px] w-px bg-border" />
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label="Size and zoom"
                  tooltip="Size & zoom"
                  tooltipSide="top"
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.dock .size` (padding 0 8px), off the control's own pad
                  className="rounded-lg bg-clip-border px-[8px] text-muted-foreground aria-expanded:bg-accent"
                >
                  <Text variant="code" tone="faint">
                    <Text tone="strong" className="font-medium">
                      {layout.width}
                    </Text>
                    {TIMES}
                    <Text tone="strong" className="font-medium">
                      {layout.height}
                    </Text>
                  </Text>
                  {/* The zoom only shows once the frames are scaled down. */}
                  {percent < 100 ? (
                    <Text variant="code" tone="faint">
                      {percent}%
                    </Text>
                  ) : null}
                </Button>
              }
            />
            <PopoverContent
              anchor={dock}
              side="top"
              align="end"
              sideOffset={10}
              padding="panel"
              aria-label="Size and zoom"
              className="w-[300px] max-w-(--available-width)"
            >
              <SizePopoverBody layout={layout} noWholePage={noWholePage} />
            </PopoverContent>
          </Popover>
        </Stack>
      </Surface>
    </ControlSizeProvider>
  );
}

/** A dock device button: lit (`.ib.on`) while its size is in force. */
function DeviceButton({
  icon,
  label,
  tooltip,
  on,
  onClick,
}: {
  icon: IconRef;
  label: string;
  tooltip?: string;
  on: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <IconButton
      icon={icon}
      label={label}
      tooltip={tooltip}
      tooltipSide="top"
      aria-pressed={on}
      onClick={onClick}
      // `bg-clip-border` so the fill runs under the 1px border: lit, that
      // border is the `--line-2` ring drawn over the raise-2 wash, as the
      // mockup's inset ring is.
      className={cn(
        "rounded-lg bg-clip-border text-muted-foreground",
        on && "border-border bg-accent text-foreground",
      )}
    />
  );
}

/** The Size popover: every size, then the Width, Zoom and Whole page bands. */
function SizePopoverBody({ layout, noWholePage }: SizeChipProps): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const { size, zoom } = canvas;
  const wholePage = canvas.wholePage && !noWholePage;
  const browserWindow = useWindowSize();
  const percent = Math.round(layout.scale * 100);
  const setSize = (next: CanvasSize) =>
    dispatch({ type: "setSize", size: next });
  const setPercent = (p: number) =>
    dispatch({ type: "setZoom", zoom: zoomFromPercent(p) });
  // − / + land on the next multiple of the step, so 62% goes to 60% / 70%.
  const lower = Math.ceil(percent / ZOOM_STEP) * ZOOM_STEP - ZOOM_STEP;
  const higher = Math.floor(percent / ZOOM_STEP) * ZOOM_STEP + ZOOM_STEP;

  return (
    <>
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.pop .ph` (padding 8px 10px), off the ramp */}
      <div className="px-[10px] py-[8px]">
        <Text as="h5" variant="group" tone="muted">
          Size
        </Text>
      </div>
      <Stack gap="none" role="radiogroup" aria-label="Size">
        <SizeRow
          checked={size.kind === "responsive"}
          icon={swapHorizIcon}
          dims="fills the canvas"
          onSelect={() => setSize({ kind: "responsive" })}
        >
          Responsive
        </SizeRow>
        <SizeRow
          checked={size.kind === "window"}
          icon={webAssetIcon}
          dims={`${String(browserWindow.w)}${TIMES}${String(browserWindow.h)}`}
          hint="What the real app gets in this browser window."
          onSelect={() => setSize({ kind: "window" })}
        >
          This window
        </SizeRow>
        {SIZE_PRESETS.map((p) => (
          <SizeRow
            key={p.name}
            checked={size.kind === "preset" && size.preset === p.name}
            icon={presetIcon(p.name)}
            dims={`${String(p.w)}${TIMES}${String(p.h)}`}
            onSelect={() => setSize({ kind: "preset", preset: p.name })}
          >
            {p.name}
          </SizeRow>
        ))}
        {size.kind === "custom" ? (
          <SizeRow
            checked
            icon={desktopWindowsIcon}
            dims={`${String(size.w)}${TIMES}${String(size.h)}`}
          >
            Custom
          </SizeRow>
        ) : null}
      </Stack>
      <Band>
        <BandLabel value={`${String(layout.width)}px`}>Width</BandLabel>
        <Slider
          aria-label="Width"
          title="Any width; snaps onto a preset it comes near"
          // The track is 4px but the input's hit area 16px: the negative
          // margins hand the band the track's own height, as the mockup's
          // bare `.slider` has.
          // eslint-disable-next-line spacing/no-adhoc-spacing -- cancels the range input's hit-area overhang (6px each side)
          className="-my-[6px] w-full"
          min={MIN_WIDTH}
          max={MAX_WIDTH}
          step={1}
          value={Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, layout.width))}
          onValueChange={(w) =>
            setSize(sizeForWidth(w, layout.width, layout.height))
          }
        />
      </Band>
      <Band>
        <BandLabel
          value={
            <Button
              variant="ghost"
              aspect="inline"
              aria-label="Actual size"
              tooltip="Actual size"
              aria-pressed={zoom === 1}
              className="font-mono font-medium text-foreground"
              onClick={() => dispatch({ type: "setZoom", zoom: 1 })}
            >
              {percent}%
            </Button>
          }
        >
          Zoom
        </BandLabel>
        <ControlSizeProvider size="xs">
          <Stack
            direction="row"
            gap="none"
            align="center"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.zrow` (gap 6px), off the ramp
            className="gap-[6px]"
          >
            <Button
              variant="outline"
              aria-pressed={zoom === "fit"}
              tooltip="The whole frame visible at once"
              // The mockup's `.zrow .fit`: 24px, radius 7, 12px muted; on, the
              // accent-soft fill in an accent-line border.
              // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.fit` (padding 0 9px), off the control's own pad
              className={cn(
                "rounded-control px-[9px] text-control text-muted-foreground",
                zoom === "fit" &&
                  "border-primary/45 bg-primary/14 text-foreground hover:bg-primary/14",
              )}
              onClick={() => dispatch({ type: "setZoom", zoom: "fit" })}
            >
              Fit
            </Button>
            <IconButton
              icon={removeIcon}
              label="Zoom out"
              disabled={percent <= MIN_ZOOM * 100}
              className="hover:bg-accent"
              onClick={() => setPercent(lower)}
            />
            <Fill>
              <Slider
                aria-label="Zoom"
                className="w-full"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                step={1}
                detent={100}
                value={percent}
                onValueChange={setPercent}
              />
            </Fill>
            <IconButton
              icon={addIcon}
              label="Zoom in"
              disabled={percent >= MAX_ZOOM * 100}
              className="hover:bg-accent"
              onClick={() => setPercent(higher)}
            />
          </Stack>
        </ControlSizeProvider>
      </Band>
      <Band>
        <WithTooltip
          content={
            noWholePage
              ? undefined
              : "Show the entire page content, not just one screen."
          }
          side="right"
        >
          <Line
            as="button"
            type="button"
            role="switch"
            aria-checked={wholePage}
            disabled={noWholePage}
            onClick={() => dispatch({ type: "setWholePage", on: !wholePage })}
            className="focus-ring w-full gap-sm rounded-control text-caption text-muted-foreground disabled:cursor-default"
          >
            <Icon icon={descriptionIcon} className="size-3.75" />
            <span>
              Whole page
              {noWholePage ? <span> · sized to its window</span> : null}
            </span>
            <Fill />
            <SwitchIndicator checked={wholePage} disabled={noWholePage} />
          </Line>
        </WithTooltip>
      </Band>
    </>
  );
}

/**
 * One size in the Size popover's list (`.slist li`): a check slot, the size's
 * glyph, its name and its dimensions. The current one is in the text colour
 * with an accent check, the rest muted.
 */
function SizeRow({
  checked,
  icon,
  dims,
  hint,
  onSelect,
  children,
}: {
  checked: boolean;
  icon: IconRef;
  dims: string;
  hint?: string;
  onSelect?: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <WithTooltip content={hint} side="right">
      <Line
        as="button"
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onSelect}
        // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.slist li` (padding 7px 10px), off the ramp
        className={cn(
          "focus-ring w-full gap-sm rounded-panel-row px-[10px] py-[7px] text-left hover:bg-hover-fill",
          checked ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <Center className="size-[18px]">
          {checked ? (
            <Icon icon={checkIcon} className="size-3.75 text-primary-text" />
          ) : null}
        </Center>
        <Center className="size-[18px] text-faint-foreground">
          <Icon icon={icon} className="size-3.75" />
        </Center>
        <Fill>
          <Text variant="body">{children}</Text>
        </Fill>
        <Text tone="faint" className="font-mono text-2xs">
          {dims}
        </Text>
      </Line>
    </WithTooltip>
  );
}

/** A band of the Size popover under a hairline (`.psec`). */
function Band({ children }: { children: ReactNode }): ReactElement {
  return (
    <Stack
      gap="none"
      // eslint-disable-next-line spacing/no-adhoc-spacing -- the mockup's `.psec` (margin-top 6px, padding 10px 10px 6px, gap 10px), off the ramp
      className="mt-[6px] gap-[10px] border-t border-border/64 px-[10px] pt-[10px] pb-[6px]"
    >
      {children}
    </Stack>
  );
}

/** A band's label row (`.psec .lbl`): the name, and its value in mono. */
function BandLabel({
  value,
  children,
}: {
  value: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <Stack direction="row" gap="none" justify="between" align="center">
      <Text variant="caption" tone="muted">
        {children}
      </Text>
      <Text variant="caption" tone="strong" className="font-mono font-medium">
        {value}
      </Text>
    </Stack>
  );
}

/** A preset's glyph in the size list. */
function presetIcon(preset: (typeof SIZE_PRESETS)[number]["name"]): IconRef {
  switch (preset) {
    case "Phone":
      return phoneIphoneIcon;
    case "Tablet":
      return tabletMacIcon;
    case "Laptop":
      return laptopMacIcon;
    case "Desktop":
      return desktopWindowsIcon;
    case "Wide":
      return computerIcon;
  }
}
