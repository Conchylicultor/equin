import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  Dialog,
  DialogContent,
  ScrollArea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { SearchResult } from "@plugins/search/plugins/engine/core";
import { useSearch } from "../internal/use-search";
import { parseHighlightedSnippet } from "../internal/parse-snippet";

export interface QuickFindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Restrict the search to these source ids (omit to search every source). */
  sources?: string[];
  /** Search-input placeholder. Default "Search…". */
  placeholder?: string;
  /** Called with the chosen result; the host owns navigation. */
  onSelect: (result: SearchResult) => void;
  /** Optional per-result leading icon (e.g. a page icon from result.metadata). */
  renderIcon?: (result: SearchResult) => ReactNode;
}

// Render a highlighted snippet as React nodes (no dangerouslySetInnerHTML).
function Snippet({ snippet }: { snippet: string }) {
  const segments = parseHighlightedSnippet(snippet);
  return (
    <span className="truncate text-caption text-muted-foreground">
      {segments.map((seg, i) =>
        seg.highlight ? (
          <mark
            key={i}
            className="rounded-sm bg-primary/15 px-2xs font-medium text-primary-text"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/** Stable identity for "no settled hits", so the key handler does not churn. */
const NO_HITS: SearchResult[] = [];

export function QuickFindDialog({
  open,
  onOpenChange,
  sources,
  placeholder = "Search…",
  onSelect,
  renderIcon,
}: QuickFindDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        {/* Self-key the body on `open` so query + activeIdx re-initialize on every
            open via a fresh mount — no props-to-state reset effect. */}
        <QuickFindDialogBody
          key={open ? "open" : "closed"}
          onOpenChange={onOpenChange}
          sources={sources}
          placeholder={placeholder}
          onSelect={onSelect}
          renderIcon={renderIcon}
        />
      </DialogContent>
    </Dialog>
  );
}

function QuickFindDialogBody({
  onOpenChange,
  sources,
  placeholder = "Search…",
  onSelect,
  renderIcon,
}: Omit<QuickFindDialogProps, "open">) {
  const [query, setQuery] = useState("");
  // Set only by keyboard nav / hover; reset to 0 in the query onChange (where
  // new results originate) and clamped in render for the async-arrival edge case.
  const [activeIdx, setActiveIdx] = useState(0);
  const activeRef = useRef<HTMLButtonElement>(null);

  // The body mounts only while the dialog is open (keyed on `open` below the
  // DialogContent), so the search is read only then.
  const search = useSearch(query, { sources });
  // Keyboard navigation walks the settled hits; with none settled (loading, a
  // failure) there is nothing to walk.
  const list = foldResource(search, {
    loading: () => NO_HITS,
    error: () => NO_HITS,
    ready: (hits) => hits,
  });

  // Derive the effective active index — never index past the current list, and
  // collapse to 0 when empty. Replaces the reset-to-0-on-results effect.
  const safeActiveIdx =
    list.length > 0 ? Math.min(activeIdx, list.length - 1) : 0;

  const select = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (list.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (Math.min(i, list.length - 1) + 1) % list.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(
          (i) => (Math.min(i, list.length - 1) - 1 + list.length) % list.length,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const chosen = list[safeActiveIdx];
        if (chosen) select(chosen);
      }
    },
    [list, safeActiveIdx, select],
  );

  useEffect(() => {
    revealElement(activeRef.current, { block: "nearest" });
  }, [safeActiveIdx]);

  const hasQuery = query.trim().length > 0;

  return (
    <>
      {/* The dialog panel owns the inset, so this band applies none of its own
          inline padding and BLEEDS instead: the rule underneath spans the whole
          panel while the input inside it lands back on the panel's rail. It is a
          direct child of the panel, which is what makes a bleed free (see the
          caveat in `dialog.tsx`). */}
      <div className="border-b rail-bleed py-sm">
        <SearchInput
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // First result highlighted after each keystroke (results refresh).
            setActiveIdx(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
        />
      </div>

      <ScrollArea className="max-h-80">
        {/* Block rhythm only: the list opens NO region of its own, so its rows
            inherit the panel's rail by doing nothing. The rows themselves do not
            `rail-bleed`: their fill is a rounded pill that reads as inset by
            design, and this list lives inside a `ScrollArea` whose viewport is
            `overflow: scroll` on BOTH axes — a bleeding child there buys 16px of
            sideways scroll rather than a wider fill. Only the bands outside the
            scroller bleed. */}
        <div className="py-xs">
          {!hasQuery ? (
            <Placeholder>Type to search.</Placeholder>
          ) : search.status === "loading" ? (
            <Loading variant="rows" />
          ) : search.status === "error" ? (
            <ResourceErrorInline
              variant="block"
              subject="search results"
              error={search.error}
              refetch={search.refetch}
            />
          ) : list.length === 0 ? (
            <Placeholder>No results.</Placeholder>
          ) : (
            // eslint-disable-next-line data-view/no-adhoc-row-list -- Cmd-K transient search overlay
            list.map((result, idx) => (
              <Row
                key={`${result.source}:${result.entityId}`}
                ref={idx === safeActiveIdx ? activeRef : undefined}
                selected={idx === safeActiveIdx}
                icon={renderIcon?.(result)}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => select(result)}
              >
                <Stack gap="2xs" align="start" className={yieldClass("x")}>
                  <Text as="span" variant="body" className="truncate">
                    {result.title || "Untitled"}
                  </Text>
                  {result.snippet && result.snippet !== result.title && (
                    <Snippet snippet={result.snippet} />
                  )}
                </Stack>
              </Row>
            ))
          )}
        </div>
      </ScrollArea>
    </>
  );
}
