import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { APP_RAIL_WIDTH, type RailFramingProps } from "@plugins/apps-core/core";
import { AppRail } from "@plugins/apps-core/plugins/app-rail/web";

/**
 * The default rail: an icon rail (`APP_RAIL_WIDTH`) beside the app content. Sets
 * `--app-rail-width` (the rail's own width, read by AppRail) and places the
 * rail as a flex sibling of `body`, so the body starts after the rail. The app
 * shell's sidebar — fixed but bounded to `body` — pins to `body`'s left edge
 * with no extra offset. Pixel-identical to the pre-region app rail. While the
 * surface mode owns the frame (`showRail` false) the rail is left out and the
 * width var drops to 0 — `body` stays where it is, so no tab remounts.
 */
export function RailFraming({ body, showRail }: RailFramingProps) {
  return (
    <Stack
      direction="row"
      gap="none"
      className="h-full min-h-0"
      style={
        {
          "--app-rail-width": showRail ? APP_RAIL_WIDTH : "0px",
        } as React.CSSProperties
      }
    >
      {showRail ? <AppRail /> : null}
      {body}
    </Stack>
  );
}
