import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useDarkMode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import type { ThemeRow } from "../internal/theme-rows";

const COLOR_BARS = [
  "primary",
  "secondary",
  "accent",
  "muted",
  "border",
  "card",
] as const;

/**
 * A theme's gallery cover: its colour bars standing on its own background,
 * filling the card's cover frame. The card around it — the frame, the name and
 * source lines under it, the selected ring, the click, the hover actions — is
 * the gallery's one `DataCard`, reached through `DataViewProps.cover`. All this
 * owns is the preview, dimmed while its own save is in flight.
 */
export function ThemePreview({
  row,
  isPending,
}: {
  row: ThemeRow;
  isPending: boolean;
}) {
  const dark = useDarkMode();
  const colors = dark ? row.preview.dark : row.preview.light;

  return (
    <Grid
      cols={COLOR_BARS.length}
      gap="xs"
      align="end"
      className={cn("size-full p-md", isPending && "opacity-50")}
      style={{ backgroundColor: colors.background }}
    >
      {COLOR_BARS.map((key) => (
        <div
          key={key}
          className="h-1/2 rounded-sm"
          style={{ backgroundColor: colors[key] }}
        />
      ))}
    </Grid>
  );
}
