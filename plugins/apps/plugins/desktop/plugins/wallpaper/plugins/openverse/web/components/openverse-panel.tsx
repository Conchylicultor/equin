import {
  WallpaperSearchPanel,
  type WallpaperCandidate,
} from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";

/**
 * Openverse provider Panel — a one-liner over the shared {@link WallpaperSearchPanel},
 * parameterized to the `openverse` server-side provider. The shared panel owns the
 * debounced query, the generic `wallpaperSearch` read (`useLive`), and the thumbnail grid.
 */
export function OpenversePanel({
  onPick,
}: {
  onPick: (candidate: WallpaperCandidate) => void;
}) {
  return <WallpaperSearchPanel providerId="openverse" onPick={onPick} />;
}
