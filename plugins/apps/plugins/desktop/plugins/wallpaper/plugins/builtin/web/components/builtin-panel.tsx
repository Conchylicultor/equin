import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useConfig } from "@plugins/config_v2/web";
import {
  BUILTIN_WALLPAPERS,
  wallpaperConfig,
} from "@plugins/apps/plugins/desktop/plugins/wallpaper/core";
import {
  builtinWallpaperUrl,
  type WallpaperCandidate,
} from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";

/**
 * Built-in provider Panel: a grid of the bundled wallpapers. Emits a `builtin`
 * candidate the picker writes straight to config (no server save). The gradient
 * has no picture, so its tile is a plain swatch labelled as following the theme.
 */
export function BuiltinPanel({
  onPick,
}: {
  onPick: (candidate: WallpaperCandidate) => void;
}) {
  const { state } = useConfig(wallpaperConfig);
  return (
    <Grid minCellWidth="8rem" gap="sm">
      {BUILTIN_WALLPAPERS.map((w) => {
        const url = builtinWallpaperUrl(w.id);
        const selected = state.kind === "builtin" && state.id === w.id;
        return (
          <button
            key={w.id}
            type="button"
            onClick={() => onPick({ kind: "builtin", id: w.id })}
            aria-pressed={selected}
            // eslint-disable-next-line layout/no-adhoc-layout -- a picker tile: aspect-ratio image button with a selection ring, no Stack/Cluster primitive expresses it
            className="aspect-video overflow-hidden rounded-md border border-border bg-muted text-left aria-pressed:ring-2 aria-pressed:ring-primary"
          >
            {url ? (
              <img src={url} alt={w.title} className="size-full object-cover" />
            ) : (
              <Center>
                <Text variant="caption" tone="muted">
                  {w.title} (follows the theme)
                </Text>
              </Center>
            )}
          </button>
        );
      })}
    </Grid>
  );
}
