import {
  cn,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Color } from "../../core";

/** A swatch: a CSS color, or a named suggestion (`{ name: "violet", color: "#7c5cff" }`). */
export type Swatch = string | { name: string; color: string };

export interface SwatchGridProps {
  colors: readonly Swatch[];
  value?: string;
  /** The picked swatch's color — for a plain string swatch, that exact string. */
  onChange: (color: string) => void;
  className?: string;
  /**
   * Optional display transform: maps a swatch's canonical color to the CSS
   * actually painted in its cell. `value` matching and `onChange` still operate
   * on the canonical color — only the rendered background changes. Lets a
   * consumer show a derived shade (e.g. Sonata's black-key color) while keeping
   * the stored/selected value the base color.
   */
  renderColor?: (color: string) => string;
}

export function swatchColor(swatch: Swatch): string {
  return typeof swatch === "string" ? swatch : swatch.color;
}

export function colorsMatch(a: string, b: string): boolean {
  const ca = Color.fromCss(a);
  const cb = Color.fromCss(b);
  if (!ca || !cb) return a.toLowerCase() === b.toLowerCase();
  return ca.equals(cb);
}

/** "violet" → "Violet": suggestion names are written lower-case in declarations. */
export function displayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function hexOf(color: string): string {
  return Color.fromCss(color)?.toHex() ?? color;
}

/**
 * A row of color dots. Plain colors wrap as small dots; named suggestions get
 * a larger dot with the name under it, in a five-column grid. A tooltip names
 * the color (and its hex) either way.
 */
export function SwatchGrid({
  colors,
  value,
  onChange,
  className,
  renderColor,
}: SwatchGridProps) {
  const named = colors.some((s) => typeof s !== "string");
  const items = colors.map((swatch) => {
    const color = swatchColor(swatch);
    const name = typeof swatch === "string" ? null : swatch.name;
    const selected = value != null && colorsMatch(value, color);
    const paint = renderColor ? renderColor(color) : color;

    if (!named) {
      // Plain colors render exactly as they always have: a bare dot.
      return (
        <button
          key={color}
          type="button"
          aria-label={color}
          aria-pressed={selected}
          onClick={() => onChange(color)}
          className={cn(
            "size-5 rounded-full border border-border transition-transform",
            selected &&
              "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background",
          )}
          style={{ background: paint }}
        />
      );
    }

    const label = name ? displayName(name) : hexOf(color);
    const tooltip = name ? `${label} · ${hexOf(color)}` : label;
    return (
      <WithTooltip key={name ?? color} content={tooltip}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={selected}
          onClick={() => onChange(color)}
          className={cn(
            "rounded-md py-2xs text-muted-foreground hover:bg-muted hover:text-foreground",
            selected && "text-foreground",
          )}
        >
          <Stack as="span" gap="2xs" align="center">
            <span
              className={cn(
                "size-6 rounded-full border border-border",
                selected &&
                  "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ background: paint }}
            />
            <Text variant="caption">{label}</Text>
          </Stack>
        </button>
      </WithTooltip>
    );
  });

  return named ? (
    <Grid cols={5} gap="2xs" className={className}>
      {items}
    </Grid>
  ) : (
    <Cluster gap="xs" className={className}>
      {items}
    </Cluster>
  );
}
