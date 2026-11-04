import type { PointerEvent } from "react";
import {
  PointerSensor,
  useSensor,
  type PointerSensorOptions,
  type SensorDescriptor,
} from "@dnd-kit/core";
import { isChromeGesture } from "@plugins/primitives/plugins/dom/plugins/gesture-origin/web";

/**
 * dnd-kit's `PointerSensor`, activating only on a press that is the handle's
 * own (`isChromeGesture`): not one bubbled through React from a portaled
 * popover opened inside the handle, and not one in text entry. Without it, a
 * press-and-drag selecting text in a pane header's popover or its path editor
 * picked the whole column up instead.
 *
 * The one pointer sensor every drag primitive mounts (sortable-list,
 * rank-reorder, the page editor). `options` must be stable (module-level):
 * `useSensor` memoizes on it.
 */
export function useChromePointerSensor(
  options: PointerSensorOptions,
): SensorDescriptor<PointerSensorOptions> {
  return useSensor(chromePointerSensor(), options);
}

let sensorClass: typeof PointerSensor | undefined;

// Defined on first use, not at module load: build-time barrel imports load
// this module against stubbed dnd-kit, whose `PointerSensor` is no class.
function chromePointerSensor(): typeof PointerSensor {
  sensorClass ??= class ChromePointerSensor extends PointerSensor {
    static override activators = [
      {
        eventName: "onPointerDown" as const,
        handler: (event: PointerEvent, opts: PointerSensorOptions): boolean =>
          isChromeGesture(event) &&
          PointerSensor.activators.every((a) => a.handler(event, opts)),
      },
    ];
  };
  return sensorClass;
}
