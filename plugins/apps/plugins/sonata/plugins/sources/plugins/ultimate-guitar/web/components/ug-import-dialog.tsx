import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  DialogTitle,
  DialogDescription,
  ScrollArea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { openSongImperative } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { compile } from "../compile";
import { extractUgTabId, UgFetchError, type UgSearchResult } from "../../core";
import {
  fetchUgTab,
  createUltimateGuitarSong,
  searchUgTabs,
} from "../../shared/endpoints";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const musicNoteIcon = symbol("music-note");

/**
 * Debounce a value: the returned value lags `input` by `delayMs` of quiet time.
 * Inlined (the `quick-find/use-search.ts` twin is plugin-private) — an 8-line
 * useState + setTimeout/clearTimeout that resets the timer on every change.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/** True when `query` parses as a UG tab URL (so it should import directly). */
function looksLikeUgUrl(query: string): boolean {
  try {
    extractUgTabId(query);
    return true;
  } catch (err) {
    // extractUgTabId throws UgFetchError("invalid-url") for anything that isn't
    // a UG tab URL — that's the signal we're probing for. Re-throw anything else.
    if (err instanceof UgFetchError) return false;
    throw err;
  }
}

type TypeFilter = "chords" | "all";

const TYPE_OPTIONS = [
  { id: "chords" as const, label: "Chords" },
  { id: "all" as const, label: "All types" },
];

/**
 * Import dialog for the Ultimate Guitar source, rendered INSIDE the
 * imperative-dialog host's `DialogContent` (so it paints its own panel + title).
 *
 * **Smart single input.** One field both searches UG's catalog (free text) and
 * imports directly (a pasted tab URL):
 * - URL mode (`looksLikeUgUrl`) → no results list, a single "Import this tab"
 *   button funnelling through `importByUrl`.
 * - Search mode → debounced `searchUgTabs` (AbortController-guarded so a stale
 *   request never clobbers a newer one), a client-side type filter (Chords vs
 *   all), and a results list whose rows import on click.
 *
 * Both paths funnel through `importByUrl`, which is **fetch-first**: fetch the
 * raw `UgTab` → `compile()` it client-side (so the same recognise-gate + timing
 * synthesis the player uses decides the metrics) → derive `durationSec`/`endBeat`
 * → create the song. Only then do we open it. Fetching before creating means a
 * cancel (or a fetch failure) never leaves a half-formed "Untitled" orphan in
 * the library — the song row is written exactly once, after the round-trip.
 *
 * Loud-failure posture: any fetch/compile/search error is surfaced in a
 * `role="alert"` red line, never swallowed and never rethrown out of a handler
 * (which would crash the dialog mid-import).
 */
export function UgImportDialog({ onClose }: { onClose: () => void }) {
  const fetchEndpoint = useFetchEndpoint();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("chords");
  const [error, setError] = useState<string | null>(null);

  // Search state.
  const [results, setResults] = useState<UgSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Per-row import progress: the tabId currently being imported (disables the
  // whole list while the fetch→compile→create round-trip runs).
  const [importingId, setImportingId] = useState<string | null>(null);

  const [activeIdx, setActiveIdx] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  const trimmed = query.trim();
  const isUrl = trimmed.length > 0 && looksLikeUgUrl(trimmed);
  const isSearch = trimmed.length > 0 && !isUrl;

  // Debounce only the search text — URL mode imports on an explicit click.
  const debouncedQuery = useDebouncedValue(isSearch ? trimmed : "", 150);

  // Fire the search whenever the debounced query changes, aborting the prior
  // request so a slow earlier response can never overwrite a newer one.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- async-fetch with cancel guard: debounced UG catalog search hits a POST endpoint (useEndpoint is GET-only, so it cannot express this); the synchronous setState calls are pre-fetch loading-state resets and an AbortController drops stale responses */
    if (debouncedQuery.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setError(null);
    fetchEndpoint(
      searchUgTabs,
      {},
      { body: { query: debouncedQuery }, signal: controller.signal },
    )
      .then((res) => {
        setResults(res.results);
        setActiveIdx(0);
        setSearching(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setResults([]);
        setSearching(false);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [debouncedQuery, fetchEndpoint]);

  // Client-side type filter: "Chords" keeps anything whose UG type contains
  // "Chords" (covers both "Chords" and "Ukulele Chords" — the two that compile
  // to a songsheet); "All types" passes everything through.
  const filtered = useMemo(
    () =>
      typeFilter === "all"
        ? results
        : results.filter((r) => r.type.includes("Chords")),
    [results, typeFilter],
  );

  // The active row resets to the top wherever the visible list actually changes
  // — when fresh search results arrive (in the fetch .then above) and when the
  // type filter toggles (in its onChange below) — so no setState-in-effect is
  // needed to mirror `filtered`.
  useEffect(() => {
    revealElement(activeRef.current, { block: "nearest" });
  }, [activeIdx]);

  // `Button` auto-pends on a promise-returning onClick (spinner + double-click
  // guard); the result rows drive their own `importingId` spinner instead.
  const importByUrl = useCallback(
    async (url: string) => {
      const target = url.trim();
      if (target.length === 0) return;
      setError(null);
      try {
        const tab = await fetchEndpoint(
          fetchUgTab,
          {},
          { body: { url: target } },
        );
        const score = compile({ tab, alignment: null });
        const endBeat = scoreEndBeat(score);
        const song = await fetchEndpoint(
          createUltimateGuitarSong,
          {},
          {
            body: {
              ...tab,
              durationSec: beatToSeconds(score, endBeat),
              endBeat,
            },
          },
        );
        onClose();
        openSongImperative(song);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onClose, fetchEndpoint],
  );

  const importResult = useCallback(
    async (result: UgSearchResult) => {
      if (importingId !== null) return;
      setImportingId(result.tabId);
      try {
        await importByUrl(
          `https://tabs.ultimate-guitar.com/tab/${result.tabId}`,
        );
      } finally {
        setImportingId(null);
      }
    },
    [importByUrl, importingId],
  );

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isUrl && e.key === "Enter") {
        e.preventDefault();
        void importByUrl(trimmed);
        return;
      }
      if (!isSearch || filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const chosen = filtered[activeIdx];
        if (chosen) void importResult(chosen);
      }
    },
    [isUrl, isSearch, filtered, activeIdx, importByUrl, importResult, trimmed],
  );

  const listDisabled = importingId !== null;

  return (
    <Stack gap="md">
      <Stack gap="2xs">
        <DialogTitle>Import from Ultimate Guitar</DialogTitle>
        <DialogDescription>
          Search for a song or paste a tab URL to import chords, sections, and
          lyrics.
        </DialogDescription>
      </Stack>

      <SearchInput
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="Search songs or paste a tab URL…"
        spellCheck={false}
      />

      {isSearch ? (
        <SegmentedControl
          variant="ghost"
          options={TYPE_OPTIONS}
          value={typeFilter}
          onChange={(v) => {
            setTypeFilter(v);
            setActiveIdx(0);
          }}
        />
      ) : null}

      {error ? (
        <Text variant="caption" tone="destructive" role="alert">
          {error}
        </Text>
      ) : null}

      {isUrl ? (
        <Stack direction="row" gap="sm" justify="end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => importByUrl(trimmed)}>Import this tab</Button>
        </Stack>
      ) : isSearch ? (
        <ScrollArea className="max-h-80">
          {searching && filtered.length === 0 ? (
            <Loading variant="rows" />
          ) : filtered.length === 0 ? (
            <Placeholder>No results.</Placeholder>
          ) : (
            <Stack gap="2xs">
              {/* eslint-disable-next-line data-view/no-adhoc-row-list -- import search-result picker (dialog chrome) */}
              {filtered.map((result, idx) => {
                const importing = importingId === result.tabId;
                return (
                  <Row
                    key={result.tabId}
                    ref={idx === activeIdx ? activeRef : undefined}
                    selected={idx === activeIdx}
                    disabled={listDisabled}
                    icon={
                      importing ? (
                        <Spinner className="size-4" />
                      ) : (
                        <Icon icon={musicNoteIcon} />
                      )
                    }
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => importResult(result)}
                  >
                    <Fill>
                      <Stack gap="2xs" align="start">
                        <Inline gap="xs" wrap>
                          <Text variant="body" className="font-semibold">
                            {result.songName || "Untitled"}
                          </Text>
                          <Text variant="caption" tone="muted">
                            {result.artistName}
                          </Text>
                        </Inline>
                        <Inline gap="xs" wrap>
                          <Badge>{result.type}</Badge>
                          <Text variant="caption" tone="muted">
                            {`★${result.rating.toFixed(1)} · ${result.votes}`}
                            {result.version !== null
                              ? ` · v${result.version}`
                              : ""}
                          </Text>
                        </Inline>
                      </Stack>
                    </Fill>
                  </Row>
                );
              })}
            </Stack>
          )}
        </ScrollArea>
      ) : (
        <Placeholder>Type a song name to search.</Placeholder>
      )}
    </Stack>
  );
}
