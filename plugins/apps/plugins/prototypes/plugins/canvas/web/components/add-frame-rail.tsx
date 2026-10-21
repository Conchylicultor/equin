import type { ReactElement } from "react";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  IconButton,
  type IconButtonProps,
} from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  ADD_FRAME_LABEL,
  compareWithLabel,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import { usePrototypeDetail } from "../context";
import { FrameSource, type FrameResolution } from "../slots";
import type { CanvasAddAction } from "../internal/canvas-model";

const addIcon = symbol("add");
const compareIcon = symbol("compare");

/** What one of the rail's buttons does when pressed: a click, or a link's gestures. */
export type AddFrameHandlers = Partial<
  Pick<IconButtonProps, "onClick" | "onAuxClick" | "onMouseDown">
>;

/**
 * The canvas's add actions, as one column of icon buttons on its right edge —
 * the same rail on the canvas pane and in every presentation: `+` (a copy of
 * the last prototype frame, to change its variant or version) and one
 * **Compare with <addLabel>** per contributed frame source this prototype
 * resolves (the real app, swiped over it) — disabled while that source is
 * already on the canvas. Names no source.
 *
 * By default each dispatches its action to this canvas. A surface that leads
 * elsewhere (Present's overlays, its new-tab page) passes `extend`, and
 * `disabled` (with the reason as tooltip) when it cannot add at all.
 */
export function AddFrameRail({
  meta,
  extend,
  disabled,
}: {
  meta: PrototypeMeta;
  extend?: (action: CanvasAddAction) => AddFrameHandlers;
  /** Why no button can add here; every button is disabled with it as tooltip. */
  disabled?: string;
}): ReactElement {
  const { canvas, sources, dispatch } = usePrototypeDetail();
  const handlers = (action: CanvasAddAction): AddFrameHandlers =>
    disabled !== undefined
      ? {}
      : extend !== undefined
        ? extend(action)
        : { onClick: () => dispatch(action) };
  return (
    <ControlSizeProvider size="sm">
      <Stack direction="col" gap="xs" align="center">
        <IconButton
          variant="floating"
          icon={addIcon}
          label={ADD_FRAME_LABEL}
          tooltip={
            disabled ??
            "Add a frame to compare — a copy of the last one, to change its variant or version"
          }
          disabled={disabled !== undefined}
          {...handlers({ type: "addPrototype" })}
        />
        {sources.map((source) => {
          const onCanvas = canvas.frames.some(
            (f) => f.kind === "source" && f.source === source.id,
          );
          const reason =
            disabled ??
            (onCanvas
              ? `${source.addLabel} is already on the canvas`
              : undefined);
          return (
            <FrameSource.Dispatch
              key={source.id}
              source={source.id}
              meta={meta}
            >
              {(resolution: FrameResolution) =>
                resolution.status === "found" ? (
                  <IconButton
                    variant="floating"
                    icon={compareIcon}
                    label={compareWithLabel(source.addLabel)}
                    tooltip={reason}
                    disabled={reason !== undefined}
                    {...(reason === undefined
                      ? handlers({ type: "addSource", source: source.id })
                      : {})}
                  />
                ) : null
              }
            </FrameSource.Dispatch>
          );
        })}
      </Stack>
    </ControlSizeProvider>
  );
}
