import type { ReactElement } from "react";

import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { SIZE_PRESETS } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { CanvasSize } from "../internal/canvas-model";
import {
  MAX_WIDTH,
  MAX_ZOOM,
  MIN_WIDTH,
  MIN_ZOOM,
  sizeForWidth,
  sizeName,
  zoomFromPercent,
  type FrameLayout,
} from "../internal/layout";
import { usePrototypeDetail } from "../context";
import { useWindowSize } from "../internal/use-window-size";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const computerIcon = symbol("computer");
const desktopWindowsIcon = symbol("desktop-windows");
const laptopMacIcon = symbol("laptop-mac");
const descriptionIcon = symbol("description");
const phoneIphoneIcon = symbol("phone-iphone");
const swapHorizIcon = symbol("swap-horiz");
const tabletMacIcon = symbol("tablet-mac");
const webAssetIcon = symbol("web-asset");

/**
 * Size, zoom and Whole page: ONE chip for the whole canvas ("This window
 * 1728 × 990 | Fit · 62%"), opening a menu with the sizes, a Width slider for
 * any width between them (snapping onto a preset), the zoom (Fit,
 * a 10–200% slider, and a value box that jumps to 100%) and the Whole page
 * switch. Every frame follows it.
 *
 * `layout` is what the canvas computed — the logical size and scale the chip
 * reports; it is handed in rather than recomputed so the chip and the frames
 * can never disagree. `noWholePage` says Whole page is on but no frame has a
 * page to show — each sizes itself to its window — so the switch reads off,
 * disabled, with the reason in its label (a disabled row shows no tooltip).
 */
export function SizeChip({
  layout,
  noWholePage,
}: {
  layout: FrameLayout;
  noWholePage: boolean;
}): ReactElement {
  const { canvas, dispatch } = usePrototypeDetail();
  const { size, zoom } = canvas;
  const wholePage = canvas.wholePage && !noWholePage;
  const browserWindow = useWindowSize();
  const percent = Math.round(layout.scale * 100);
  const zoomLabel =
    zoom === "fit" ? `Fit · ${String(percent)}%` : `${String(percent)}%`;

  return (
    <ControlPanelPopover
      side="top"
      align="end"
      label="Size and zoom"
      trigger={
        <Button variant="floating" aria-label="Size and zoom">
          <SizeIcon size={size} />
          <span>{sizeName(size)}</span>
          <span className="tabular-nums text-muted-foreground">
            {layout.width} × {layout.height}
          </span>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <span className="tabular-nums">{zoomLabel}</span>
          {wholePage ? (
            <Icon
              icon={descriptionIcon}
              className="text-primary-text"
              aria-label="Whole page"
            />
          ) : null}
        </Button>
      }
    >
      <ControlPanel>
        <ControlPanel.Section label="Size">
          <ControlPanel.Row
            select="radio"
            checked={size.kind === "responsive"}
            trailing="fills the canvas"
            onSelect={() =>
              dispatch({ type: "setSize", size: { kind: "responsive" } })
            }
          >
            Responsive
          </ControlPanel.Row>
          <ControlPanel.Row
            select="radio"
            checked={size.kind === "window"}
            trailing={`${String(browserWindow.w)} × ${String(browserWindow.h)}`}
            hint="What the real app gets in this browser window."
            onSelect={() =>
              dispatch({ type: "setSize", size: { kind: "window" } })
            }
          >
            This window
          </ControlPanel.Row>
          {SIZE_PRESETS.map((p) => (
            <ControlPanel.Row
              key={p.name}
              select="radio"
              checked={size.kind === "preset" && size.preset === p.name}
              trailing={`${String(p.w)} × ${String(p.h)}`}
              onSelect={() =>
                dispatch({
                  type: "setSize",
                  size: { kind: "preset", preset: p.name },
                })
              }
            >
              {p.name}
            </ControlPanel.Row>
          ))}
          {size.kind === "custom" ? (
            <ControlPanel.Row
              select="radio"
              checked
              trailing={`${String(size.w)} × ${String(size.h)}`}
            >
              Custom
            </ControlPanel.Row>
          ) : null}
        </ControlPanel.Section>
        <ControlPanel.Section label="Width">
          <Stack direction="row" gap="sm" align="center">
            <Fill>
              <Slider
                aria-label="Width"
                title="Any width; snaps onto a preset it comes near"
                className="w-full"
                min={MIN_WIDTH}
                max={MAX_WIDTH}
                step={1}
                value={Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, layout.width))}
                onValueChange={(w) =>
                  dispatch({
                    type: "setSize",
                    size: sizeForWidth(w, layout.width, layout.height),
                  })
                }
              />
            </Fill>
            <span className="w-14 text-right tabular-nums text-muted-foreground">
              {layout.width}px
            </span>
          </Stack>
        </ControlPanel.Section>
        <ControlPanel.Section label="Zoom">
          <Stack direction="row" gap="sm" align="center">
            <Button
              variant={zoom === "fit" ? "secondary" : "outline"}
              aria-pressed={zoom === "fit"}
              tooltip="The whole frame visible at once"
              onClick={() => dispatch({ type: "setZoom", zoom: "fit" })}
            >
              Fit
            </Button>
            <Fill>
              <Slider
                aria-label="Zoom"
                className="w-full"
                min={MIN_ZOOM * 100}
                max={MAX_ZOOM * 100}
                step={1}
                detent={100}
                value={percent}
                onValueChange={(v) =>
                  dispatch({ type: "setZoom", zoom: zoomFromPercent(v) })
                }
              />
            </Fill>
            <Button
              variant={zoom === 1 ? "secondary" : "outline"}
              aria-pressed={zoom === 1}
              aria-label="Actual size"
              tooltip="Actual size"
              className="w-14 tabular-nums"
              onClick={() => dispatch({ type: "setZoom", zoom: 1 })}
            >
              {percent}%
            </Button>
          </Stack>
        </ControlPanel.Section>
        <ControlPanel.Section>
          <ControlPanel.Row
            select="switch"
            checked={wholePage}
            disabled={noWholePage}
            icon={<Icon icon={descriptionIcon} />}
            hint="Show the entire page content, not just one screen."
            onSelect={() => dispatch({ type: "setWholePage", on: !wholePage })}
          >
            Whole page
            {noWholePage ? (
              <span className="text-muted-foreground">
                {" "}
                · sized to its window
              </span>
            ) : null}
          </ControlPanel.Row>
        </ControlPanel.Section>
      </ControlPanel>
    </ControlPanelPopover>
  );
}

/** The chip's leading glyph for the size in force. */
function SizeIcon({ size }: { size: CanvasSize }): ReactElement {
  switch (size.kind) {
    case "responsive":
      return <Icon icon={swapHorizIcon} />;
    case "window":
      return <Icon icon={webAssetIcon} />;
    case "preset": {
      const preset = size.preset;
      return preset === "Phone" ? (
        <Icon icon={phoneIphoneIcon} />
      ) : preset === "Tablet" ? (
        <Icon icon={tabletMacIcon} />
      ) : preset === "Laptop" ? (
        <Icon icon={laptopMacIcon} />
      ) : preset === "Wide" ? (
        <Icon icon={computerIcon} />
      ) : (
        <Icon icon={desktopWindowsIcon} />
      );
    }
    case "custom":
      return <Icon icon={desktopWindowsIcon} />;
  }
}
