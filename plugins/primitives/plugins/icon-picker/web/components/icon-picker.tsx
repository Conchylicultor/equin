import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useEffect } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import {
  runtimeSymbol,
  type SavedSymbolName,
} from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  loadSymbolSet,
  type SymbolEntry,
  type SymbolSet,
} from "../internal/icons";

const COLUMNS = 9;

export interface IconPickerProps {
  /** Currently-selected icon, highlighted in the grid. */
  value: SavedSymbolName | null;
  /** Fired with the picked Material Symbols name — what the caller stores. */
  onSelect: (name: SavedSymbolName) => void;
  className?: string;
}

type GridRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "icons"; key: string; entries: readonly SymbolEntry[] };

function rowsOf(
  groups: readonly { label: string | null; entries: readonly SymbolEntry[] }[],
): GridRow[] {
  const rows: GridRow[] = [];
  for (const { label, entries } of groups) {
    if (label !== null) rows.push({ kind: "header", key: `h:${label}`, label });
    for (let i = 0; i < entries.length; i += COLUMNS) {
      const slice = entries.slice(i, i + COLUMNS);
      rows.push({ kind: "icons", key: `r:${slice[0]!.name}`, entries: slice });
    }
  }
  return rows;
}

/**
 * Searchable, categorized grid of the Material Symbols set. Loads the picker
 * data lazily on first mount, so callers should only mount it when the picker
 * is visible (e.g. inside an open popover). Renders just the icon block
 * (header + search + grid) — surface chrome (popover, color rows) is the
 * caller's responsibility.
 *
 * The grid is windowed (`VirtualRows`) and every cell is an `<Icon>` on a
 * runtime symbol, so only the rows on screen fetch their glyphs — in the
 * surrounding scope's icon style, the style the picked icon will be drawn in.
 *
 * That includes the CONTENT INSET: this block applies none of its own, so it
 * lands on whatever rail its host establishes. Inside a `ControlPanel` that is
 * the panel's icon rail, which is what puts the "Icon" label, the search field
 * and the grid on the same x as every other block in the panel — a second inset
 * here is exactly the double-ownership the panel's inset rule exists to stop.
 */
export function IconPicker({ value, onSelect, className }: IconPickerProps) {
  const [query, setQuery] = useState("");
  const [set, setSet] = useState<SymbolSet | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  if (failure) throw failure;

  useEffect(() => {
    void loadSymbolSet().then(setSet, (err: unknown) =>
      setFailure(err instanceof Error ? err : new Error(String(err))),
    );
  }, []);

  const isSearching = query.trim().length > 0;
  const results = isSearching && set ? set.search(query) : [];
  const rows = set
    ? rowsOf(
        isSearching
          ? [{ label: null, entries: results }]
          : set.categories.map((c) => ({ label: c.label, entries: c.entries })),
      )
    : [];

  return (
    <Stack gap="xs" className={className}>
      {/* Header + search */}
      <Stack direction="row" align="center" justify="between" gap="none">
        {/* No look override: inside a menu surface (a `ControlPanel`, a
            popover) `SectionLabel` IS the shared menu label, so this heading
            matches the panel's own `ControlPanel.Section label` beside it. */}
        <SectionLabel as="span">
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- inline left offset on the "loading…" suffix next to the label text */}
          Icon{!set && <span className="ml-1 opacity-50">· loading…</span>}
        </SectionLabel>
        {set && (
          <span className="text-3xs text-muted-foreground/50">
            {set.count} icons
          </span>
        )}
      </Stack>
      <SearchInput
        appearance="menu"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search icons…"
      />

      {/* Icon grid */}
      <Scroll className="max-h-64">
        {!set ? (
          <Loading label="Loading icons…" className="py-2xl text-center" />
        ) : isSearching && results.length === 0 ? (
          <Text
            as="p"
            variant="caption"
            className="py-lg text-center text-muted-foreground"
          >
            No icons match &ldquo;{query}&rdquo;
          </Text>
        ) : (
          <VirtualRows<GridRow>
            items={rows}
            estimateSize={32}
            getKey={(row) => row.key}
          >
            {(row) =>
              row.kind === "header" ? (
                <SectionLabel className="pt-xs pb-2xs">
                  {row.label}
                </SectionLabel>
              ) : (
                <Grid cols={COLUMNS} gap="xs" className="pb-xs">
                  {row.entries.map((entry) => (
                    <IconBtn
                      key={entry.name}
                      entry={entry}
                      selected={value === entry.name}
                      onPick={onSelect}
                    />
                  ))}
                </Grid>
              )
            }
          </VirtualRows>
        )}
      </Scroll>
    </Stack>
  );
}

function IconBtn({
  entry,
  selected,
  onPick,
}: {
  entry: SymbolEntry;
  selected: boolean;
  onPick: (name: SavedSymbolName) => void;
}) {
  return (
    <button
      type="button"
      aria-label={entry.label}
      aria-pressed={selected}
      title={entry.label}
      onClick={() => onPick(entry.name)}
      className={cn(
        "size-7 rounded-md text-foreground/80 hover:bg-accent",
        selected && "bg-accent text-foreground ring-1 ring-ring",
      )}
    >
      <Center>
        <Icon icon={runtimeSymbol(entry.name)} className="size-4" />
      </Center>
    </button>
  );
}
