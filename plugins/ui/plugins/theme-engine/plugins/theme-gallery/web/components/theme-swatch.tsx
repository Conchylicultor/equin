import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useDarkMode } from "@plugins/primitives/plugins/syntax-highlight/web";
import type { ThemeRow } from "../internal/theme-rows";

/** The four vars that read as a theme's identity at swatch size. */
const SWATCH_KEYS = ["primary", "secondary", "accent", "background"] as const;

/**
 * The BODY of one theme in the compact list picker: a few identity dots from
 * the theme's palette, plus the name, on one line. The row around it — chrome,
 * the selected highlight, click, hover, the `sm` density — is the list's own,
 * and selecting the theme is the surface's `onRowActivate`.
 *
 * The gallery card over a `ThemePreview` cover is the full-size shape; a
 * popover needs a dozen of these above the fold, so the preview collapses to
 * dots instead of the card merely shrinking.
 */
export function ThemeSwatch({
  row,
  isPending,
}: {
  row: ThemeRow;
  isPending: boolean;
}) {
  const dark = useDarkMode();
  const vars = dark ? row.preview.dark : row.preview.light;

  return (
    <Line className={cn("gap-sm", isPending && "opacity-50")} title={row.label}>
      <Stack as="span" direction="row" gap="2xs" align="center">
        {SWATCH_KEYS.map((key) => (
          <span
            key={key}
            className="size-2.5 rounded-full border border-border/60"
            style={{ backgroundColor: vars[key] }}
          />
        ))}
      </Stack>
      {/* A `<Text>` leaf in the ONE flexible cell of the line, so a long catalog
          name ("APOTHEOSIS MINT MIDNIGHT") ellipsizes at the row edge instead
          of bleeding over the neighbouring swatch. */}
      <Fill>
        <Text as="span" variant="caption">
          {row.label}
        </Text>
      </Fill>
    </Line>
  );
}
