import {
  cn,
  Dialog,
  DialogContent,
  ScrollArea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useMemo, useCallback } from "react";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { CommandPaletteItem } from "../slots";
import { fuzzyMatch, type FuzzyMatch } from "./fuzzy";
import { Icon } from "@plugins/ui/plugins/icons/web";

interface CommandPaletteDialogProps {
  open: boolean;
  onClose: () => void;
  items: readonly CommandPaletteItem[];
}

type ScoredItem = CommandPaletteItem & { _match: FuzzyMatch | null };

interface Group {
  label: string | null;
  items: ScoredItem[];
}

function bestMatch(query: string, item: CommandPaletteItem): FuzzyMatch | null {
  let best = fuzzyMatch(query, item.label);
  if (item.keywords) {
    for (const kw of item.keywords) {
      const m = fuzzyMatch(query, kw);
      if (m && (!best || m.score > best.score)) {
        best = { score: m.score, ranges: [] };
      }
    }
  }
  return best;
}

function groupItems(items: ScoredItem[]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const item of items) {
    const label = item.group ?? null;
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

function HighlightedLabel({
  label,
  ranges,
}: {
  label: string;
  ranges: [number, number][];
}) {
  if (ranges.length === 0) return <>{label}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) parts.push(label.slice(last, start));
    parts.push(
      <span key={start} className="font-semibold text-foreground">
        {label.slice(start, end)}
      </span>,
    );
    last = end;
  }
  if (last < label.length) parts.push(label.slice(last));
  return <>{parts}</>;
}

export function CommandPaletteDialog({
  open,
  onClose,
  items,
}: CommandPaletteDialogProps) {
  // The stateful body is mounted only while `open` — so it naturally remounts
  // (re-initializing `query`/`activeIdx` via `useState`) on every closed→open
  // transition, replacing the old mirror-`open`-into-state effect. The Dialog
  // shell stays mounted so its close animation is preserved.
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* No corner ✕: the footer already spells out `esc close`, so the button
          would be a second way to say the same thing in a surface whose whole
          point is that your hands stay on the keyboard. */}
      <DialogContent size="md" showCloseButton={false}>
        {open && <CommandPaletteBody onClose={onClose} items={items} />}
      </DialogContent>
    </Dialog>
  );
}

function CommandPaletteBody({
  onClose,
  items,
}: {
  onClose: () => void;
  items: readonly CommandPaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const { filtered, groups } = useMemo(() => {
    if (!query) {
      const all: ScoredItem[] = items.map((item) => ({
        ...item,
        _match: null,
      }));
      return { filtered: all, groups: groupItems(all) };
    }
    const scored: ScoredItem[] = [];
    for (const item of items) {
      const m = bestMatch(query, item);
      if (m) scored.push({ ...item, _match: m });
    }
    scored.sort((a, b) => (b._match?.score ?? 0) - (a._match?.score ?? 0));
    return { filtered: scored, groups: null };
  }, [items, query]);

  const flatList = groups ? groups.flatMap((g) => g.items) : filtered;

  const select = useCallback(
    (item: ScoredItem) => {
      item.onSelect();
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % flatList.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + flatList.length) % flatList.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (flatList[activeIdx]) select(flatList[activeIdx]);
      }
    },
    [flatList, activeIdx, select],
  );

  let flatIdx = 0;

  return (
    <>
      {/* The dialog panel owns the inset. The search band and the hint
              footer apply none of their own and BLEED instead, so their rules
              span the whole panel while their contents land back on the panel's
              rail. Both are direct children of the panel, which is what makes a
              bleed free (see the caveat in `dialog.tsx`). */}
      <div className="border-b rail-bleed py-sm">
        <SearchInput
          appearance="menu"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search commands..."
        />
      </div>

      <ScrollArea className="max-h-80">
        {/* Block rhythm only: the list opens NO region of its own, so its
                group labels and rows inherit the panel's rail by doing nothing.
                The rows do not `rail-bleed`: their active fill is a rounded pill
                that reads as inset by design, and this list lives inside a
                `ScrollArea` whose viewport is `overflow: scroll` on BOTH axes —
                a bleeding child there buys 16px of sideways scroll rather than a
                wider fill. Only the bands outside the scroller bleed. */}
        <div className="py-xs">
          {flatList.length === 0 && (
            <Text
              as="p"
              variant="body"
              className="py-xl text-center text-muted-foreground"
            >
              No commands found.
            </Text>
          )}

          {groups
            ? groups.map((group) => (
                <div key={group.label ?? "__ungrouped"}>
                  {group.label && (
                    <Text
                      as="div"
                      variant="caption"
                      className="px-sm py-xs font-medium text-muted-foreground"
                    >
                      {group.label}
                    </Text>
                  )}
                  {group.items.map((item) => {
                    const idx = flatIdx++;
                    return (
                      <CommandRow
                        key={item.id}
                        item={item}
                        isActive={idx === activeIdx}
                        onMouseEnter={() => setActiveIdx(idx)}
                        onClick={() => select(item)}
                      />
                    );
                  })}
                </div>
              ))
            : filtered.map((item) => {
                const idx = flatIdx++;
                return (
                  <CommandRow
                    key={item.id}
                    item={item}
                    isActive={idx === activeIdx}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => select(item)}
                  />
                );
              })}
        </div>
      </ScrollArea>

      <Text
        as="div"
        variant="caption"
        className="border-t rail-bleed py-xs text-muted-foreground"
      >
        <Stack direction="row" gap="md">
          <span>
            <Kbd className="border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground">
              ↑↓
            </Kbd>{" "}
            navigate
          </span>
          <span>
            <Kbd className="border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground">
              ↵
            </Kbd>{" "}
            select
          </span>
          <span>
            <Kbd className="border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground">
              esc
            </Kbd>{" "}
            close
          </span>
        </Stack>
      </Text>
    </>
  );
}

function CommandRow({
  item,
  isActive,
  onMouseEnter,
  onClick,
}: {
  item: ScoredItem;
  isActive: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const revealRef = useRevealOnActive(isActive);
  const icon = item.icon;
  return (
    <Line
      ref={revealRef}
      role="option"
      aria-selected={isActive}
      className={cn(
        // `px-sm` is the row's OWN pad, inside its own fill — not a second copy
        // of the panel's rail, which the list above already inherits.
        "cursor-pointer gap-sm rounded-md px-sm py-xs text-body",
        isActive && "bg-accent text-accent-foreground",
      )}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      {icon && (
        <Icon
          icon={icon}
          className={cn("size-4 text-muted-foreground", rigidClass())}
        />
      )}
      <Fill as="span">
        <Text tone="muted">
          <HighlightedLabel
            label={item.label}
            ranges={item._match?.ranges ?? []}
          />
        </Text>
      </Fill>
      {item.shortcut && (
        <Kbd className="border-muted-foreground/30 bg-muted-foreground/10 text-muted-foreground">
          {item.shortcut}
        </Kbd>
      )}
    </Line>
  );
}
