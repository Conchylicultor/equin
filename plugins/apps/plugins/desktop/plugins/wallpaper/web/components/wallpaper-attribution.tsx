import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useConfig } from "@plugins/config_v2/web";
import { wallpaperConfig, getBuiltinWallpaper } from "../../core";

/**
 * Small corner credit for the current wallpaper (open-license compliance), after
 * the mockup's `#wall-credit`: 10.5px, 38% white (80% on hover), bottom-right,
 * above the shelf area. A built-in reads "Elarun — Nuno Pinheiro, KDE Plasma ·
 * LGPLv3"; an image reads "Photo by {creator} · {license}". Renders nothing for the
 * gradient or an image with no attribution; links to `sourceUrl` when there is one.
 * `hidden` fades it out (the overview). Hidden below 1180px wide, like the mockup's dock layout.
 */
export function WallpaperAttribution({ hidden = false }: { hidden?: boolean }) {
  const { state } = useConfig(wallpaperConfig);

  let label: string;
  let sourceUrl: string | undefined;
  if (state.kind === "builtin") {
    const attr = getBuiltinWallpaper(state.id)?.attribution;
    if (!attr) return null;
    label = `${getBuiltinWallpaper(state.id)?.title} — ${attr.creator}, ${attr.source} · ${attr.license}`;
    sourceUrl = attr.sourceUrl;
  } else if (state.kind === "image") {
    const creator = state.attribution?.creator?.trim();
    const license = state.attribution?.license?.trim();
    if (!creator && !license) return null;
    label = [creator ? `Photo by ${creator}` : "Photo", license]
      .filter(Boolean)
      .join(" · ");
    sourceUrl = state.attribution?.sourceUrl?.trim();
  } else {
    return null;
  }

  /* eslint-disable layout/no-adhoc-layout -- the mockup's #wall-credit: a 12px/8px bottom-right corner credit, hidden on narrow desktops; Pin's offsets are tokens, not these literals */
  const creditClass = cn(
    "absolute right-[12px] bottom-[8px] hidden text-[10.5px] text-white/40 transition-colors hover:text-white/80 min-[1180px]:block",
    hidden && "pointer-events-none opacity-0",
  );
  /* eslint-enable layout/no-adhoc-layout */

  return (
    <div className={creditClass}>
      {sourceUrl ? (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-inherit no-underline hover:underline"
        >
          {label}
        </a>
      ) : (
        label
      )}
    </div>
  );
}
