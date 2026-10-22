import { Icon } from "@plugins/ui/plugins/icons/web";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { cn, Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { useBlockActivate } from "@plugins/page/plugins/editor/web";
import { placeSearch, type PlaceSuggestion } from "../../core";
import { useDebouncedValue } from "../internal/use-debounced-value";
import type { PlaceProviderContribution } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

const locationOnIcon = symbol("location-on");

/**
 * How long typing must settle before a lookup fires. Providers meter searches,
 * so this is a cost knob as much as a latency one.
 */
const SEARCH_DEBOUNCE_MS = 200;

export interface PlaceSearchProps {
  provider: PlaceProviderContribution;
  /** The current search-round token, sent with every query of this round. */
  session: string;
  onPick: (suggestion: PlaceSuggestion) => void;
}

/**
 * The empty block's search box: type, wait for the debounce, then pick a result
 * with the mouse or with ArrowUp/ArrowDown + Enter.
 *
 * The block's caret host owns focus and the ↑/↓ escape — this box reports
 * nothing and registers nothing. It keeps its OWN arrows only while it has
 * suggestions to move through, which it already signals the one way the protocol
 * asks for: by calling `preventDefault()`. The host runs its escape on
 * `defaultPrevented`, so "the caret can always leave a void block" and "the
 * arrows walk this result list" are both true, with no coordination between
 * them.
 */
export function PlaceSearch({ provider, session, onPick }: PlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // An empty place block is a PROMPT — it is asking which place — so Enter on
  // the block's caret host puts the caret in the search box — and so does the
  // block arriving under the caret (`/place`), where the next keystroke is the
  // query.
  useBlockActivate(() => inputRef.current?.focus(), { onArrival: true });
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  const searching = debounced.length > 0;
  // Nothing is read until there is a question: one tuple per settled query.
  const search = useLive(
    placeSearch,
    searching ? { providerId: provider.id, q: debounced, session } : null,
  );
  // The suggestions the arrows walk: only an answered search has any — a
  // search still asking or failed has none to walk (and renders its own state).
  const suggestions = foldResource(search, {
    ready: (answer) => answer.suggestions,
    loading: () => null,
    error: () => null,
  });

  function choose(index: number) {
    const suggestion = suggestions?.[index];
    if (!suggestion) return;
    onPick(suggestion);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (suggestions === null || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  }

  const icon = provider.icon ?? locationOnIcon;
  const AccessAction = provider.AccessAction;
  const hasResults = suggestions !== null && suggestions.length > 0;

  return (
    <Stack gap="xs">
      <Stack direction="row" gap="sm" align="center">
        <Icon
          icon={icon}
          className={cn(rigidClass(), "size-4 text-muted-foreground")}
        />
        <Fill>
          <Input
            // Chrome, not document content: the query is discarded on
            // selection, so its ⌘Z belongs to the browser's own input
            // history. Without the marker the block list's `surfaceUndoProps`
            // ancestor claims the key and rewinds an unrelated block edit.
            {...localUndoProps}
            ref={inputRef}
            value={query}
            placeholder={`Search ${provider.label}…`}
            aria-label="Search for a place"
            aria-controls={listId}
            aria-activedescendant={
              hasResults ? `${listId}-${active}` : undefined
            }
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </Fill>
      </Stack>

      {/* The lookup itself broke — say so. An empty list means "the provider
          found nothing", and a failure must never be readable as that. A
          provider that says it is not set up gets its fix beside the message —
          never in place of it: the fix may draw nothing when the client still
          believes the provider ready (a key the server cannot read). */}
      {searching && search.status === "error" ? (
        <Stack gap="2xs">
          <ResourceErrorInline
            error={search.error}
            refetch={search.refetch}
            variant="inline"
          />
          {search.error.kind === "refused" &&
          search.error.code === "not-configured" &&
          AccessAction ? (
            <AccessAction />
          ) : null}
        </Stack>
      ) : null}

      {searching && suggestions !== null && hasResults ? (
        <Surface level="overlay">
          <Scroll axis="y" className="max-h-64">
            <Inset pad="2xs">
              <div id={listId} role="listbox" aria-label="Place results">
                {/* eslint-disable-next-line data-view/no-adhoc-row-list -- transient typeahead chrome: provider predictions that exist only while this dropdown is open and are discarded on selection, not a collection of domain records */}
                {suggestions.map((suggestion, i) => (
                  <Row
                    key={suggestion.placeId}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(i)}
                  >
                    <Fill>
                      <Line>
                        <Text variant="label">{suggestion.primary}</Text>
                      </Line>
                      {suggestion.secondary ? (
                        <Line>
                          <Text variant="caption" tone="muted">
                            {suggestion.secondary}
                          </Text>
                        </Line>
                      ) : null}
                    </Fill>
                  </Row>
                ))}
              </div>
            </Inset>
          </Scroll>
        </Surface>
      ) : null}

      {searching && search.status === "loading" ? (
        <Loading variant="text" label="Searching…" />
      ) : null}

      {searching && suggestions !== null && !hasResults ? (
        <Placeholder>No place matched “{debounced}”.</Placeholder>
      ) : null}
    </Stack>
  );
}
