import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const contentCopyIcon = symbol("content-copy");
const cropIcon = symbol("crop");
const downloadIcon = symbol("download");
const editIcon = symbol("edit");
const refreshIcon = symbol("refresh");
const panToolIcon = symbol("pan-tool");
const undoIcon = symbol("undo");

export type Tool = "none" | "crop" | "draw";

export interface DrawSettings {
  color: string;
  width: number;
}

const COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#000000",
  "#ffffff",
];

interface Props {
  tool: Tool;
  onToolChange: (t: Tool) => void;
  drawSettings: DrawSettings;
  onDrawSettingsChange: (s: DrawSettings) => void;
  hasStrokes: boolean;
  onApplyDraw: () => void;
  onClearStrokes: () => void;
  onUndoStroke: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onReset: () => void;
}

export function ToolsPane(props: Props) {
  return (
    <Stack gap="none" className="h-full">
      {/* eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band */}
      <Text as="div" variant="label" className="border-b px-md py-sm">
        Tools
      </Text>

      <div className="border-b p-md">
        <Grid cols={3} gap="xs">
          <ToolButton
            active={props.tool === "none"}
            onClick={() => props.onToolChange("none")}
            label="View"
            icon={<Icon icon={panToolIcon} className="size-4" />}
          />
          <ToolButton
            active={props.tool === "crop"}
            onClick={() => props.onToolChange("crop")}
            label="Crop"
            icon={<Icon icon={cropIcon} className="size-4" />}
          />
          <ToolButton
            active={props.tool === "draw"}
            onClick={() => props.onToolChange("draw")}
            label="Draw"
            icon={<Icon icon={editIcon} className="size-4" />}
          />
        </Grid>
      </div>

      {props.tool === "crop" && (
        <div className="border-b p-md">
          <Text as="div" variant="caption" tone="muted">
            Drag a rectangle on the image to crop.
          </Text>
        </div>
      )}

      {props.tool === "draw" && (
        <div
          // eslint-disable-next-line spacing/no-adhoc-spacing -- space-y on a bordered padded section; no named space-y utility, can't be a clean Stack
          className="space-y-3 border-b p-md"
        >
          <Stack gap="xs">
            <Text as="div" variant="label" tone="muted">
              Color
            </Text>
            <Stack direction="row" gap="xs" wrap>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() =>
                    props.onDrawSettingsChange({
                      ...props.drawSettings,
                      color: c,
                    })
                  }
                  className={cn(
                    "size-6 rounded-full border-2 transition",
                    props.drawSettings.color === c
                      ? "border-foreground scale-110"
                      : "border-border",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </Stack>
          </Stack>
          <Stack gap="xs">
            <Text as="div" variant="label" tone="muted">
              <Stack
                direction="row"
                gap="none"
                align="center"
                justify="between"
              >
                <span>Width</span>
                <span>{props.drawSettings.width}px</span>
              </Stack>
            </Text>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={props.drawSettings.width}
              onChange={(e) =>
                props.onDrawSettingsChange({
                  ...props.drawSettings,
                  width: Number(e.target.value),
                })
              }
              className="w-full"
            />
          </Stack>
          <Stack direction="row" gap="sm">
            <Button onClick={props.onApplyDraw} disabled={!props.hasStrokes}>
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={props.onUndoStroke}
              disabled={!props.hasStrokes}
            >
              <Icon icon={undoIcon} className="size-4" />
              Undo
            </Button>
            <Button
              variant="outline"
              onClick={props.onClearStrokes}
              disabled={!props.hasStrokes}
            >
              Clear
            </Button>
          </Stack>
        </div>
      )}

      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- space-y on a bordered padded footer; no named space-y utility, can't be a clean Stack */}
      <div className="mt-auto space-y-2 border-t p-md">
        <Button variant="outline" className="w-full" onClick={props.onCopy}>
          <Icon icon={contentCopyIcon} className="size-4" />
          Copy to clipboard
        </Button>
        <Button variant="outline" className="w-full" onClick={props.onDownload}>
          <Icon icon={downloadIcon} className="size-4" />
          Download PNG
        </Button>
        <Button variant="ghost" className="w-full" onClick={props.onReset}>
          <Icon icon={refreshIcon} className="size-4" />
          Reset to original
        </Button>
      </div>
    </Stack>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      onClick={onClick}
      className="h-auto py-sm"
    >
      <Stack gap="2xs" align="center">
        {icon}
        <span className="text-3xs">{label}</span>
      </Stack>
    </Button>
  );
}
