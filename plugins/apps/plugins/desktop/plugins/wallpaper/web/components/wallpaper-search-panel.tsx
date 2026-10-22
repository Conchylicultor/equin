import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  WALLPAPER_QUERY_MAX,
  wallpaperSearch,
  type WallpaperCandidate,
} from "../../core";

/**
 * Shared search panel for any server-side wallpaper provider (Openverse, …).
 * Parameterized by `providerId`: it owns the debounced query input, the generic
 * `wallpaperSearch` read, and the thumbnail grid; the provider sub-plugin renders
 * `<WallpaperSearchPanel providerId="openverse" onPick={...} />` and nothing more.
 * Clicking a result emits a `remote` candidate (full url + attribution).
 */
export function WallpaperSearchPanel({
  providerId,
  onPick,
}: {
  providerId: string;
  onPick: (candidate: WallpaperCandidate) => void;
}) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  // Debounce the query so a keystroke burst asks one question. A timer reset on
  // every change settles to the latest value after the user pauses.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);

  // Nothing is read until there is a question: one tuple per settled query.
  const search = useLive(
    wallpaperSearch,
    debounced.length === 0 ? null : { provider: providerId, q: debounced },
  );

  return (
    <Stack gap="sm">
      <SearchInput
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search images…"
        maxLength={WALLPAPER_QUERY_MAX}
        autoFocus
      />
      {debounced.length === 0 ? (
        <Placeholder>Type to search open-license images.</Placeholder>
      ) : search.status === "error" ? (
        // A refusal shows the server's message (no Retry: the answer stands);
        // a failure — a provider throttling requests included — offers Retry.
        <ResourceErrorInline
          error={search.error}
          refetch={search.refetch}
          variant="block"
        />
      ) : search.status === "loading" ? (
        <Loading variant="spinner" />
      ) : search.data.length === 0 ? (
        <Placeholder>No results.</Placeholder>
      ) : (
        <Scroll axis="y" className="max-h-80">
          <Grid minCellWidth="8rem" gap="sm">
            {search.data.map((result) => (
              <button
                key={result.id}
                type="button"
                title={result.attribution?.title ?? undefined}
                onClick={() =>
                  onPick({
                    kind: "remote",
                    url: result.fullUrl,
                    attribution: result.attribution,
                  })
                }
                // eslint-disable-next-line layout/no-adhoc-layout -- thumbnail tile: the button is itself the fixed-aspect image cell within the Grid track
                className="aspect-video overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-80"
              >
                <img
                  src={result.thumbUrl}
                  alt={result.attribution?.title ?? ""}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </button>
            ))}
          </Grid>
        </Scroll>
      )}
    </Stack>
  );
}
