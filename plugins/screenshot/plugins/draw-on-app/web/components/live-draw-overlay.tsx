import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useEffect, useState } from "react";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  DrawCanvas,
  type Stroke,
} from "@plugins/screenshot/plugins/draw-canvas/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { DrawLayer } from "../internal/layer";

const closeIcon = symbol("close");
const undoIcon = symbol("undo");

const COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#000000",
  "#ffffff",
];

export interface LiveDrawOverlayProps {
  strokes: Stroke[];
  onStrokesChange: (s: Stroke[] | ((prev: Stroke[]) => Stroke[])) => void;
  color: string;
  onColorChange: (c: string) => void;
  width: number;
  onWidthChange: (w: number) => void;
  chromeVisible: boolean;
  busy: boolean;
  onDone: () => void;
  onCancel: () => void;
}

export function LiveDrawOverlay({
  strokes,
  onStrokesChange,
  color,
  onColorChange,
  width,
  onWidthChange,
  chromeVisible,
  busy,
  onDone,
  onCancel,
}: LiveDrawOverlayProps) {
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () =>
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Drive viewport-rect at 1:1 so strokes map to CSS pixels exactly.
  const displayed = new DOMRect(0, 0, viewport.w, viewport.h);
  const natural = { w: viewport.w, h: viewport.h };

  return (
    <ViewportOverlay layer={DrawLayer}>
      <DrawCanvas
        displayed={displayed}
        natural={natural}
        strokes={strokes}
        onStrokesChange={onStrokesChange}
        color={color}
        width={width}
      />

      {chromeVisible && (
        <>
          <Pin to="top" style={{ top: "1rem" }}>
            <Stack
              data-draw-chrome="true"
              direction="row"
              gap="md"
              align="center"
              className="rounded-lg border bg-background/95 px-md py-sm shadow-lg backdrop-blur"
            >
              <Stack direction="row" gap="xs" align="center">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${c}`}
                    onClick={() => onColorChange(c)}
                    className={cn(
                      "size-5 rounded-full border-2 transition",
                      color === c
                        ? "border-foreground scale-110"
                        : "border-border",
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </Stack>
              <Stack direction="row" gap="sm" align="center">
                <Text as="span" variant="label" tone="muted">
                  {width}px
                </Text>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={width}
                  onChange={(e) => onWidthChange(Number(e.target.value))}
                  className="w-24"
                />
              </Stack>
              <Stack direction="row" gap="xs" align="center">
                <IconButton
                  icon={undoIcon}
                  label="Undo"
                  onClick={() => onStrokesChange((s) => s.slice(0, -1))}
                  disabled={strokes.length === 0}
                />
                <IconButton
                  icon={closeIcon}
                  label="Clear"
                  onClick={() => onStrokesChange([])}
                  disabled={strokes.length === 0}
                />
              </Stack>
            </Stack>
          </Pin>

          <Pin to="bottom-right" style={{ bottom: "1rem", right: "1rem" }}>
            <Stack
              data-draw-chrome="true"
              direction="row"
              gap="sm"
              align="center"
            >
              <Button variant="outline" onClick={onCancel} loading={busy}>
                Cancel
              </Button>
              <Button
                onClick={onDone}
                loading={busy}
                disabled={strokes.length === 0}
              >
                Done
              </Button>
            </Stack>
          </Pin>
        </>
      )}
    </ViewportOverlay>
  );
}
