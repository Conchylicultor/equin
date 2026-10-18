import { useEffect, useState } from "react";
import {
  useEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { searchWallpaper, type WallpaperCandidate } from "../../core";

/**
 * Shared search panel for any server-side wallpaper provider (Openverse, …).
 * Parameterized by `providerId`: it owns the debounced query input, the generic
 * `searchWallpaper` call, and the thumbnail grid; the provider sub-plugin renders
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

  // Debounce the query so a keystroke burst fires one search. A timer reset on
  // every change settles to the latest value after the user pauses.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);

  const enabled = debounced.length > 0;
  const { data, isFetching, error } = useEndpoint(
    searchWallpaper,
    {},
    { query: { provider: providerId, q: debounced }, enabled },
  );

  // Surface the provider's own server message (HttpError sends it as the text
  // body) — e.g. Openverse's rate-limit notice — instead of a generic failure.
  const errorMessage =
    error instanceof EndpointError &&
    typeof error.body === "string" &&
    error.body.trim()
      ? error.body
      : "Search failed. Try again.";

  return (
    <Stack gap="sm">
      <SearchInput
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search images…"
        autoFocus
      />
      {error ? (
        <Placeholder tone="error">{errorMessage}</Placeholder>
      ) : !enabled ? (
        <Placeholder>Type to search open-license images.</Placeholder>
      ) : isFetching && !data ? (
        <Loading variant="spinner" />
      ) : data && data.length === 0 ? (
        <Placeholder>No results.</Placeholder>
      ) : (
        <Scroll axis="y" className="max-h-80">
          <Grid minCellWidth="8rem" gap="sm">
            {(data ?? []).map((result) => (
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
