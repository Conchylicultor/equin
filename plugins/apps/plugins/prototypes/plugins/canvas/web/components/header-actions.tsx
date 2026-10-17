import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { usePrototypeDetail } from "../context";
import { prototypeFrames, type CanvasLayout } from "../internal/canvas-model";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

// The canvas's header actions, each a zero-prop contribution to
// `prototypeDetailPane.Actions`: in the header they take no vertical room from
// the canvas.

/** `Side by side | Swipe` — only with exactly two frames, the one case swiping means something. */
export function LayoutAction(): ReactElement | null {
  const { canvas, dispatch } = usePrototypeDetail();
  if (canvas.frames.length !== 2) return null;
  return (
    <SegmentedControl<CanvasLayout>
      options={[
        { id: "side", label: "Side by side" },
        { id: "swipe", label: "Swipe" },
      ]}
      value={canvas.layout}
      onChange={(layout) => dispatch({ type: "setLayout", layout })}
    />
  );
}

/**
 * `+ Frame` (a copy of the last prototype frame, to change its variant or
 * version), then one `+ <addLabel>` per contributed frame source — disabled
 * while that source is already on the canvas. Names no source.
 */
export function AddFrameActions(): ReactElement {
  const { canvas, sources, dispatch } = usePrototypeDetail();
  const protos = prototypeFrames(canvas.frames);
  const last = protos.at(-1);
  return (
    <Stack direction="row" gap="xs" align="center">
      <Button
        variant="outline"
        tooltip={
          last === undefined
            ? "Add the prototype"
            : "Add a copy of the last frame — then change its variant or version"
        }
        onClick={() => dispatch({ type: "addPrototype" })}
      >
        <Icon icon={addIcon} className="text-primary-text" />
        Frame
      </Button>
      {sources.map((source) => {
        const onCanvas = canvas.frames.some(
          (f) => f.kind === "source" && f.source === source.id,
        );
        return (
          <Button
            key={source.id}
            variant="outline"
            disabled={onCanvas}
            tooltip={
              onCanvas
                ? `${source.addLabel} is already on the canvas`
                : undefined
            }
            onClick={() => dispatch({ type: "addSource", source: source.id })}
          >
            <Icon icon={addIcon} className="text-primary-text" />
            {source.addLabel}
          </Button>
        );
      })}
    </Stack>
  );
}
