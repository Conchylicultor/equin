import { useState } from "react";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { ColorAdjustment } from "@plugins/ui/plugins/theme-engine/core";
import {
  FillFromMenu,
  useColorAdjustEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { colorAdjustShortcuts } from "../shortcuts";

const SEARCH_TERMS = ["color adjust", "hue", "saturation", "lightness"];

/**
 * Whether this section answers the customizer's search box. Declared as the
 * contribution's `useAvailable` rather than a `return null` in the body: the
 * host paints the card before it reaches the body, so a null there would leave
 * a "Color Adjust" bar over nothing on every non-matching query.
 */
export function useColorAdjustMatchesSearch({
  search,
}: {
  search: string;
}): boolean {
  const q = search.trim().toLowerCase();
  return q.length === 0 || SEARCH_TERMS.some((term) => term.includes(q));
}

type AdjustmentKey = keyof ColorAdjustment;

const SLIDERS: {
  key: AdjustmentKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}[] = [
  {
    key: "hueShift",
    label: "Hue",
    min: -180,
    max: 180,
    step: 1,
    format: String,
  },
  {
    key: "saturationScale",
    label: "Saturation",
    min: 0,
    max: 2,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: "lightnessScale",
    label: "Lightness",
    min: 0.2,
    max: 2,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
];

/**
 * The theme's hue / saturation / lightness shift over every color it paints.
 * A slider shows its value live while dragged and writes it once, on release —
 * one theme edit per gesture rather than one per pixel.
 */
export function ColorAdjustSection() {
  const editor = useColorAdjustEditor();
  // The value under a slider the user is still dragging, before it is written.
  const [dragging, setDragging] = useState<{
    key: AdjustmentKey;
    value: number;
  } | null>(null);

  if (editor.pending) {
    if (editor.error !== null) {
      return (
        <ResourceErrorInline
          error={editor.error}

          refetch={editor.refetch}

          variant="block"

          subject="the theme selection"
        />
      );
    }

    return <Loading variant="rows" count={SLIDERS.length} />;
  }

  const commit = () => {
    if (dragging === null) return;
    editor.set({ [dragging.key]: dragging.value });
    setDragging(null);
  };

  return (
    <Stack gap="md">
      <FillFromMenu
        shortcuts={colorAdjustShortcuts}
        onFill={(shortcut) => editor.set(shortcut.adjustment)}
      />
      <Stack gap="sm" className="text-body">
        {SLIDERS.map(({ key, label, min, max, step, format }) => {
          const value =
            dragging?.key === key ? dragging.value : editor.adjustment[key];
          return (
            <Stack key={key} as="label" direction="row" gap="sm" align="center">
              <span className="w-24 text-muted-foreground">{label}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) =>
                  setDragging({ key, value: Number(e.target.value) })
                }
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
                className={fillClasses("x")}
              />
              <span className="w-10 text-right tabular-nums">
                {format(value)}
              </span>
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}
