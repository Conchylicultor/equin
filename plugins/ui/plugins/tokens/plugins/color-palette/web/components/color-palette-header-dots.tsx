import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { transformValues } from "@plugins/ui/plugins/theme-engine/core";
import { useTokenGroupEditor } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { colorPaletteGroup } from "../../core";

const REPRESENTATIVE_KEYS: (keyof typeof colorPaletteGroup.schema)[] = [
  "primary",
  "secondary",
  "accent",
  "background",
  "card",
  "popover",
  "muted",
  "destructive",
  "border",
];

/**
 * The section's collapsed-state preview: a few of the scope's light-mode
 * colors, as painted (color adjustment applied). Decorative, so it simply shows
 * nothing until the scope's theme is known.
 */
export function ColorPaletteHeaderDots() {
  const editor = useTokenGroupEditor(colorPaletteGroup);
  // Loading or failed alike: decorative, so nothing — the section body renders
  // the failure with its retry.
  if (editor.pending) return null;
  const painted = transformValues(editor.values.light, editor.colorAdjust);

  return (
    <Stack as="span" direction="row" align="center" gap="2xs">
      {REPRESENTATIVE_KEYS.map((key) => (
        <span
          key={key}
          className="size-2.5 rounded-full border border-border/30"
          style={{ backgroundColor: painted[key] }}
        />
      ))}
    </Stack>
  );
}
