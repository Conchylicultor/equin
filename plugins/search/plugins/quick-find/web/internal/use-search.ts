import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import {
  searchResults,
  SEARCH_QUERY_MAX,
  type SearchResult,
} from "@plugins/search/plugins/engine/core";

// Debounce a value: returns the input only after it has stayed unchanged for
// `delayMs`. Keeps type-ahead search from asking a new question on every
// keystroke.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export interface UseSearchOptions {
  /** Restrict the search to these source ids (omit to search every source). */
  sources?: string[];
}

// Debounced full-text search hook: the engine's live `search.results` value for
// the trimmed query once it is non-empty and has settled (~150ms), clamped to
// the longest question the engine answers. Live, so an open question re-ranks
// as the index changes. Until there is a settled question nothing is read and
// the result stays `loading` — the caller renders its own empty-query state.
export function useSearch(
  q: string,
  opts: UseSearchOptions = {},
): ResourceResult<SearchResult[]> {
  const debounced = useDebouncedValue(q.trim().slice(0, SEARCH_QUERY_MAX), 150);
  const sources =
    opts.sources && opts.sources.length > 0 ? opts.sources : undefined;
  return useLive(
    searchResults,
    debounced.length > 0 ? { q: debounced, sources } : null,
  );
}
