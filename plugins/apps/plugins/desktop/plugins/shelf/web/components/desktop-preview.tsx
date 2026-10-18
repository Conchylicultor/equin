import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  DesktopWallpaper,
  WindowSnapshot,
  useWorkAreaReserve,
  windowRectFraction,
  type FloatingWindow,
} from "@plugins/apps/plugins/desktop/plugins/windows/web";

/** The preview's width; its height follows the desktop's aspect (mockup). */
const PREVIEW_W = 320;

/**
 * A desktop seen from the pager (mockup `showDeskPreview`): "Desktop N" over
 * "k windows · current" (or "Empty"), above a miniature of the desktop — its
 * wallpaper, and a still snapshot of each of its visible windows at its real
 * position, all at the desktop's one scale.
 */
export function DesktopPreview({
  label,
  current,
  windows,
  desktopW,
  desktopH,
}: {
  label: string;
  current: boolean;
  /** The desktop's visible windows, back to front. */
  windows: FloatingWindow[];
  desktopW: number;
  desktopH: number;
}) {
  // Snapped windows take their tile inside the work area, above the dock.
  const reserve = useWorkAreaReserve();
  const scale = desktopW > 0 ? PREVIEW_W / desktopW : 0;
  const count = windows.length;
  const summary = `${count ? `${count} window${count > 1 ? "s" : ""}` : "Empty"}${current ? " · current" : ""}`;
  return (
    // eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.desk-prev` column (gap 6px, off the ramp)
    <div className="flex flex-col gap-[6px]">
      {/* eslint-disable-next-line layout/no-adhoc-layout, spacing/no-adhoc-spacing -- the mockup's `.dp-h`: name and summary on one baseline, 2px inset (off the ramp) */}
      <div className="flex items-baseline gap-sm px-[2px] text-caption">
        <span className="font-semibold">{label}</span>
        <Text tone="faint">{summary}</Text>
      </div>
      <div
        // eslint-disable-next-line layout/no-adhoc-layout -- the miniature clips the wallpaper and the scaled windows to its rounded corner
        className="relative overflow-hidden rounded-lg shadow-[0_0_0_0.5px_var(--input)]"
        style={{
          width: Math.round(desktopW * scale),
          height: Math.round(desktopH * scale),
        }}
      >
        <DesktopWallpaper />
        {count === 0 ? (
          <Layer decorative>
            <Center className="size-full text-caption font-medium text-white/80">
              No windows
            </Center>
          </Layer>
        ) : (
          windows.map((w) => {
            const r = windowRectFraction(w.geo, desktopW, desktopH, reserve);
            if (!r) return null;
            return (
              <div
                key={w.id}
                // eslint-disable-next-line layout/no-adhoc-layout -- a window's snapshot at its scaled desktop position
                className="pointer-events-none absolute"
                style={{
                  left: r.left * desktopW * scale,
                  top: r.top * desktopH * scale,
                }}
              >
                <WindowSnapshot
                  window={w}
                  maxW={r.width * desktopW * scale}
                  maxH={r.height * desktopH * scale}
                  fixedScale={scale}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
