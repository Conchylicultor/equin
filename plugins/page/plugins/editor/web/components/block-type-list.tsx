import { Icon } from "@plugins/ui/plugins/icons/web";
import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { useReorderedEntries } from "@plugins/reorder/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useRevealOnActive } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { BlockHandle } from "../../core";
import { Editor } from "../slots";
import { useBlockEditor, useEnabledBlockTypes } from "../block-editor-context";
import {
  entriesToSections,
  flattenSections,
  withInsertActions,
  type BlockSection,
  type InsertEntry,
  type InsertSection,
} from "../internal/block-sections";

export { flattenSections } from "../internal/block-sections";
export type {
  BlockSection,
  InsertEntry,
  InsertSection,
} from "../internal/block-sections";

/**
 * Insertable block types grouped by the `page.editor.block` slot's authored
 * config tree (Notion-style sections: "Basic blocks", "Media", …). The grouping
 * layout lives ENTIRELY in `config/page/editor/page.editor.block.jsonc` — block
 * plugins stay group-blind. A contribution carries its `block` handle; only types
 * declaring a menu `label` are offered, and when the enclosing
 * `BlockEditorProvider` sets an `enabledBlockTypes` allowlist (the in-memory
 * demo's curated text palette), non-listed types drop out — so every picker
 * respects both with no per-menu wiring. Emptied sections are dropped.
 */
export function useGroupedInsertableBlocks(): ResourceResult<BlockSection[]> {
  const contributions = Editor.Block.useContributions();
  const enabled = useEnabledBlockTypes();
  // The clean contributions carry `_pluginId` + `id`, which is all the reorder
  // entryKey needs; they lack `_slot`, so widen through `unknown`. A read: the
  // grouping is not known until the layout loads, and the raw registration
  // order never stands in for it (it would list hidden types, ungrouped).
  const order = useReorderedEntries(
    "page.editor.block",
    contributions as unknown as Contribution[],
  );
  return useMemo(
    () =>
      mapResource(order, ({ entries }) => entriesToSections(entries, enabled)),
    [order, enabled],
  );
}

/**
 * Flat insertable block list in authored-config order — `useGroupedInsertableBlocks`
 * flattened. Shared by the flat consumers (the turn-into menu), which inherit the
 * group ordering for free while ignoring the section boundaries.
 */
export function useInsertableBlocks(): ResourceResult<BlockHandle<unknown>[]> {
  const sections = useGroupedInsertableBlocks();
  return useMemo(() => mapResource(sections, flattenSections), [sections]);
}

const NO_ACTIONS: readonly never[] = [];

/**
 * The insert menus' full list for the caret's line `blockId` —
 * `useGroupedInsertableBlocks` with every contributed `Editor.InsertAction`
 * placed among the block types (see `withInsertActions`). What the `/` and
 * gutter-`+` menus render; the turn-into picker stays on block types alone,
 * since an action does not convert.
 *
 * Actions are offered only on a server-synced editor with no allowlist — the
 * gate `Editor.InsertAction` documents — and only once the server holds the
 * line itself (`rowTruthOf === "present"`). An action runs a server op ON that
 * row, and the gutter `+` opens the menu on a paragraph it inserted a moment
 * ago, optimistically: run before the insert lands, the op would 404. So the
 * actions join the list when the confirming push does — a beat after the
 * block types, never a failed request.
 */
export function useInsertMenuSections(
  blockId: string,
): ResourceResult<InsertSection[]> {
  const grouped = useGroupedInsertableBlocks();
  const { serverSync, enabledBlockTypes, rowTruthOf } = useBlockEditor();
  const contributed = Editor.InsertAction.useContributions();
  const offered =
    serverSync && !enabledBlockTypes && rowTruthOf(blockId) === "present";
  const actions = offered ? contributed : NO_ACTIONS;
  return useMemo(
    () => mapResource(grouped, (g) => withInsertActions(g, actions)),
    [grouped, actions],
  );
}

/** The words an entry answers to: its menu `label`, then its `aliases`. */
function wordsOf(entry: InsertEntry): {
  label?: string;
  aliases?: readonly string[];
} {
  return entry.kind === "block" ? entry.block : entry.action;
}

/**
 * Case-insensitive match on an entry's menu `label` plus its declared `aliases`,
 * ranked by relevance: label matches outrank alias-only matches, and prefix
 * matches outrank substring matches. Original list order is preserved within
 * each rank tier (stable sort). Block types and insert actions are ranked by
 * this one function, so neither kind is filtered by looser rules.
 */
export function filterInsertEntries<E extends InsertEntry>(
  entries: E[],
  query: string,
): E[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;

  // Lower rank = higher priority; Infinity = no match (filtered out).
  const rank = (e: E): number => {
    const words = wordsOf(e);
    const label = words.label?.toLowerCase();
    if (label?.startsWith(q)) return 0;
    if (label?.includes(q)) return 1;
    const aliases = words.aliases?.map((a) => a.toLowerCase());
    if (aliases?.some((a) => a.startsWith(q))) return 2;
    if (aliases?.some((a) => a.includes(q))) return 3;
    return Infinity;
  };

  return entries
    .map((e, i) => ({ e, i, r: rank(e) }))
    .filter((x) => x.r !== Infinity)
    .sort((a, b) => a.r - b.r || a.i - b.i) // tie-break on original index → stable
    .map((x) => x.e);
}

/**
 * One insert-menu row — a block type, or a contributed insert action. It keeps
 * ITSELF in view while active, so arrowing past the fold of a scroll-capped menu
 * follows the highlight. `block: "nearest"` is a no-op when the row is already
 * visible, which is why hover — which also moves the active index — never yanks
 * the list.
 *
 * The press wiring has two shapes, because this row is shared by two kinds of
 * surface (see `BlockTypeList`):
 *
 * - **Caret menu** (slash / gutter-`+`): `onCommit` is set. It commits on
 *   `onPointerDown` because the menu is a focus-less surface over a live editor
 *   caret — a press perturbs the host selection and unmounts this row before a
 *   `mousedown` could fire (see `useCaretMenu`'s `commit`).
 * - **Focused popover picker** (turn-into): only `onSelect` is set. It commits
 *   on `onMouseDown` + `preventDefault` so the click never blurs the picker's
 *   own search field.
 */
function InsertEntryRow<E extends InsertEntry>({
  entry,
  active,
  onSelect,
  onCommit,
  onHover,
}: {
  entry: E;
  active: boolean;
  /** Focused-picker commit — fires on `onMouseDown`. */
  onSelect?: (entry: E) => void;
  /** Caret-menu commit (already `editor.update`-wrapped) — fires on `onPointerDown`. */
  onCommit?: () => void;
  onHover: () => void;
}) {
  const revealRef = useRevealOnActive(active);
  const icon = entry.kind === "block" ? entry.block.icon : entry.action.icon;

  const pressProps = onCommit
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          e.preventDefault();
          onCommit();
        },
      }
    : {
        onMouseDown: (e: React.MouseEvent) => {
          e.preventDefault();
          onSelect?.(entry);
        },
      };

  return (
    <Row
      ref={revealRef}
      selected={active}
      // The stable hook the caret e2e enumerates block types through, so an
      // editor-owned spec can ask "is EVERY insertable type caret-reachable?"
      // without importing (and therefore hard-naming) every contributor plugin
      // — the same reason `selection-bands` carries `data-selection-band`. An
      // action row is not a type, so it answers to its own attribute instead of
      // joining that enumeration.
      data-block-type={entry.kind === "block" ? entry.block.type : undefined}
      data-insert-action={entry.kind === "action" ? entry.action.id : undefined}
      icon={
        icon ? (
          <Icon icon={icon} className="text-muted-foreground size-4" />
        ) : undefined
      }
      onMouseEnter={onHover}
      {...pressProps}
    >
      {entry.kind === "block" ? entry.block.label : entry.action.label}
    </Row>
  );
}

/** A stable React key for an entry — types and action ids are separate spaces. */
function entryKey(entry: InsertEntry): string {
  return entry.kind === "block"
    ? `block:${entry.block.type}`
    : `action:${entry.action.id}`;
}

/**
 * Presentational grouped list of insert-menu rows (icon + label). Section
 * headers are non-interactive eyebrows; only entry rows are selectable, so the
 * caller's flat `activeIndex` runs over the SELECTABLE rows only (headers never
 * consume an index — the command-palette pattern). Flat callers pass one
 * label-less section (`[{ entries }]`) → renders exactly as an ungrouped list.
 *
 * Generic over the entry kind so a caller that only ever lists block types (the
 * turn-into picker) gets block entries back from `onSelect`, with no action arm
 * to handle.
 *
 * Two commit modes, mutually exclusive (the flat index is the commit key):
 *
 * - **`onCommit(index)`** — caret menus (slash / gutter-`+`). Rows commit on
 *   `onPointerDown` through the `useCaretMenu` `commit`, which is `pointerdown`-
 *   timed and `editor.update`-wrapped so a mouse click matches the keyboard.
 * - **`onSelect(entry)`** — focused popover pickers (turn-into). Rows commit on
 *   `onMouseDown` + `preventDefault` to keep the picker's field focused.
 */
export function BlockTypeList<E extends InsertEntry>({
  sections,
  activeIndex,
  onSelect,
  onCommit,
  onHoverIndex,
}: {
  sections: InsertSection<E>[];
  activeIndex: number;
  onSelect?: (entry: E) => void;
  onCommit?: (index: number) => void;
  onHoverIndex: (index: number) => void;
}) {
  const flatCount = sections.reduce((n, s) => n + s.entries.length, 0);
  if (flatCount === 0) {
    return (
      <Text
        as="div"
        variant="body"
        className="text-muted-foreground px-sm py-xs"
      >
        No block types
      </Text>
    );
  }

  // Running index over selectable rows only — headers are skipped, so the
  // caller's keyboard `activeIndex` (0-based over the flattened entry list) maps
  // straight onto the rendered rows.
  let flatIdx = 0;
  return (
    <Stack gap="none">
      {sections.map((section, si) => (
        <div key={section.label ?? `__loose-${si}`}>
          {section.label ? (
            <Text
              as="div"
              variant="caption"
              className="text-muted-foreground px-sm pt-xs font-medium uppercase tracking-wide"
            >
              {section.label}
            </Text>
          ) : null}
          {section.entries.map((entry) => {
            const idx = flatIdx++;
            return (
              <InsertEntryRow
                key={entryKey(entry)}
                entry={entry}
                active={idx === activeIndex}
                onSelect={onSelect}
                onCommit={onCommit ? () => onCommit(idx) : undefined}
                onHover={() => onHoverIndex(idx)}
              />
            );
          })}
        </div>
      ))}
    </Stack>
  );
}
