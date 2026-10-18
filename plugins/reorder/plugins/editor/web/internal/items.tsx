import {
  Button,
  ControlSizeProvider,
  cn,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  ReorderAreaContext,
  type ReorderItemChromeProps,
} from "@plugins/reorder/plugins/area/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const closeIcon = symbol("close");
const searchIcon = symbol("search");
const storefrontIcon = symbol("storefront");

// --- Item chrome -------------------------------------------------------------

// A fill contribution that forgets `fill` works fine in normal mode (the
// wrapper is `display:contents` and the child participates in its host column
// directly) and only breaks in edit mode — a silent, mode-specific footgun. We
// can't infer "wants to fill" without the flag, but we CAN detect the symptom
// after mount and surface the missing opt-in loudly. Warn once per contribution.
const warnedMissingFill = new Set<string>();

// Tracks whether the ref'd element has zero child nodes via a MutationObserver,
// read through useSyncExternalStore so it never sets state in an effect.
function useIsEmpty(ref: RefObject<HTMLElement | null>): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const el = ref.current;
      if (!el) return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(el, { childList: true });
      return () => observer.disconnect();
    },
    [ref],
  );
  const getSnapshot = useCallback(() => {
    // Default to false (not-empty) before the ref attaches, so the
    // empty-placeholder never flashes on the first edit-mode render.
    const el = ref.current;
    if (!el) return false;
    return el.childNodes.length === 0;
  }, [ref]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

// Descend past layout-neutral `display:contents` wrappers (e.g. the element-
// picker marker span) to the contribution's first real box.
function firstBoxDescendant(root: HTMLElement): HTMLElement | null {
  let el = root.firstElementChild as HTMLElement | null;
  while (el && getComputedStyle(el).display === "contents") {
    el = el.firstElementChild as HTMLElement | null;
  }
  return el;
}

/**
 * The edit-mode dressing of one reorder item (`ReorderItemBox`), mounted inside
 * the box ahead of its content: the hover-revealed hide badge and the
 * empty-item placeholder, plus the classes it publishes for the box (the
 * draggable ring) and its content wrapper. Unmounting it publishes `null` —
 * the box falls back to its at-rest `display: contents`.
 */
export function ReorderItemChrome({
  itemKey,
  label,
  fill,
  asked,
  contentRef,
  publish,
}: ReorderItemChromeProps) {
  const ctx = useContext(ReorderAreaContext);
  const isHorizontal = ctx?.orientation === "horizontal";
  const isEmpty = useIsEmpty(contentRef);

  // Loud detection of a missing `fill` opt-in: if the contribution's root box
  // declares `flex-grow` (it wants to fill its host's height and scroll), but
  // `fill` wasn't passed, the edit-mode wrapper isn't a bounded flex column, so
  // its content overflows onto sibling rows. Turn that silent visual bug into an
  // actionable console error instead of leaving authors to discover it by eye.
  //
  // Two things narrow it, because the accusation LATCHES and a wrong one is
  // permanent for the session. `fill` is the BLOCK axis, so a horizontal area
  // can never want it — and `asked` is the other explanation for the same
  // `flex-grow`: an `AdaptiveBar` inside the contribution sets `flex-1` on
  // itself and asks the chain for room on the INLINE axis, so accusing it would
  // send an author to add a flag that turns their bar into a flex column.
  //
  // Deferred a frame, and that is not politeness: `asked` arrives one render
  // late (the ask registers in a layout effect), so a passive effect running on
  // the first commit would read `false` and latch. The re-run's cleanup cancels
  // the pending frame, so the corrected answer wins.
  useEffect(() => {
    if (fill || asked || isHorizontal || isEmpty) return;
    const frame = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      const root = firstBoxDescendant(el);
      if (!root) return;
      if (
        getComputedStyle(root).flexGrow !== "0" &&
        !warnedMissingFill.has(itemKey)
      ) {
        warnedMissingFill.add(itemKey);
        console.error(
          `[reorder] Contribution "${itemKey}" fills its host (its root sets ` +
            `flex-grow) but reorder was not told it fills: in edit mode its ` +
            `content overflows onto the rows below. Set \`fill: true\` on ` +
            `its render-slot contribution.`,
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [fill, asked, isHorizontal, isEmpty, itemKey, contentRef]);

  // The draggable edit-mode item box: a flex row (or a bounded flex-col when
  // `fill`) carrying drag chrome (cursor-grab, ring). The layout mode flips on
  // `fill` and rides with dnd-kit drag state, so the flex mechanics stay raw.
  const box = useMemo(
    () =>
      ({ isDragging }: { isDragging: boolean }) =>
        // eslint-disable-next-line layout/no-adhoc-layout -- draggable edit-mode item box; layout mode flips on fill + dnd drag chrome
        cn(
          // `control-min-sm` + centered content gives every edit-mode box a
          // uniform height floor (matching the spacer and Add button) so
          // heterogeneous contributions don't render ragged rings. Horizontal
          // boxes hug their content; vertical boxes span the column (`w-full`)
          // like the un-wrapped list rows they replace.
          "group/reorder-item relative flex control-min-sm items-center cursor-grab rounded-md ring-1 ring-primary/50",
          isHorizontal ? "" : "w-full",
          // Fill contributions span the column height as a bounded flex column
          // so their inner scroll region clamps (see `fill` docs).
          fill && "flex-col flex-1 min-h-0",
          // Relay the INLINE grow a widget inside asked for. Only in a
          // horizontal area: in a vertical one the item already spans the
          // column (`w-full`), and `flex-1` there would be the block axis —
          // which is `fill`'s question, not this one.
          asked && isHorizontal && "min-w-0 flex-1",
          isDragging && "opacity-40",
        ),
    [isHorizontal, fill, asked],
  );
  // The fill branch turns the content wrapper into a bounded flex column so a
  // contribution's inner `flex-1 min-h-0` scroll region clamps instead of
  // overflowing — a conditional layout bound tied to the fill/edit machinery,
  // kept raw.
  // eslint-disable-next-line layout/no-adhoc-layout -- conditional fill bound (bounded flex column) for the edit-mode content wrapper
  const content = cn(
    "pointer-events-none",
    // Fill the box so full-width vertical rows keep spanning the column.
    // Skip when empty — an empty `w-full` div would steal the whole row
    // from the placeholder sibling, wrapping its label onto two lines.
    !isHorizontal && !isEmpty && "w-full",
    // Propagate the fill bound to the content wrapper too, so the
    // contribution's inner `flex-1 min-h-0` scroll region resolves
    // against a bounded box instead of growing to its natural height.
    fill && !isEmpty && "flex flex-col flex-1 min-h-0 overflow-hidden",
    // The second level of the inline relay: the item box grew, and
    // this wrapper sits between it and the widget that asked.
    asked && isHorizontal && !isEmpty && "flex min-w-0 flex-1",
  );

  // Layout effects, so the box wears its chrome in the same frame it mounts and
  // drops it in the same frame it unmounts — no at-rest flash either way.
  useLayoutEffect(() => {
    publish({ box, content });
  }, [publish, box, content]);
  useLayoutEffect(() => () => publish(null), [publish]);

  return (
    <>
      {/* Hover-revealed × badge overhanging the item's top-right corner by a
          fixed pixel amount (off the density ramp) — drag-affordance chrome,
          kept as raw positioning. */}
      <button
        // eslint-disable-next-line layout/no-adhoc-layout -- hover-revealed × badge overhanging the draggable item corner (off-ramp pixel overhang)
        className="absolute -top-1.5 -right-1.5 z-raised flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-3xs opacity-0 pointer-events-none group-hover/reorder-item:opacity-80 group-hover/reorder-item:pointer-events-auto hover:!opacity-100 hover:pointer-events-auto transition-opacity"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          ctx?.onHide(itemKey);
        }}
        aria-label="Hide item"
      >
        <Icon icon={closeIcon} className="size-2.5" />
      </button>
      {isEmpty && (
        <div
          className={cn(
            "pointer-events-none select-none italic text-muted-foreground/50",
            isHorizontal
              ? "px-sm py-2xs text-3xs max-w-24 truncate"
              : "w-full px-md py-xs text-center text-caption",
          )}
        >
          {label}
        </div>
      )}
    </>
  );
}

// --- Restore button ----------------------------------------------------------

export function RestoreButton({
  hiddenItems,
  inserts,
  onRestore,
}: {
  hiddenItems: Array<{ key: string; label: string }>;
  /** Registry-driven insert affordances (e.g. "Add Spacer"). */
  inserts: Array<{ label: string; onInsert: () => void }>;
  onRestore: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasHidden = hiddenItems.length > 0;

  function handleRestore(contributionId: string) {
    onRestore(contributionId);
  }

  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="dashed" aria-label="Add items">
          <Icon icon={addIcon} className="size-3.5" />
          {hasHidden
            ? hiddenItems.length === 1
              ? "1 hidden"
              : `${hiddenItems.length} hidden`
            : "Add"}
        </Button>
      }
      width="sm"
      padding="none"
    >
      {/*
        The popover is a stack of BANDS, and the rule between two of them belongs
        to the stack, not to a band. Each band used to draw its own leading
        `border-t`, so which bands exist decided whether the first rule had
        anything above it — with nothing hidden and no inserts, the Marketplace
        band was first and still painted a rule against the popover's top edge.
        `divide-y` draws only BETWEEN siblings (`& > * + *`), so a leading rule is
        not something a band can forget to suppress: it cannot be drawn at all.
      */}
      <Stack gap="none" className="divide-y divide-border">
        {hasHidden && (
          <div className="p-xs">
            {hiddenItems.map((item) => (
              <Row
                key={item.key}
                size="sm"
                icon={<Icon icon={addIcon} className="text-muted-foreground" />}
                onClick={() => {
                  handleRestore(item.key);
                  if (hiddenItems.length <= 1) setOpen(false);
                }}
              >
                {item.label}
              </Row>
            ))}
          </div>
        )}

        {inserts.length > 0 && (
          <div className="p-xs">
            {inserts.map((insert) => (
              <Row
                key={insert.label}
                size="sm"
                icon={<Icon icon={addIcon} className="text-muted-foreground" />}
                onClick={() => {
                  insert.onInsert();
                  setOpen(false);
                }}
              >
                {insert.label}
              </Row>
            ))}
          </div>
        )}

        <div className="px-sm py-sm">
          <Inline
            as="div"
            gap="xs"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset separating the Marketplace label from the search input
            className="text-muted-foreground mb-1.5"
          >
            <Icon icon={storefrontIcon} className="size-3.5" />
            <Text as="span" variant="label">
              Marketplace
            </Text>
          </Inline>
          <div className="relative">
            {/* Decorative search glyph pinned to the input's left edge, vertically centered. `left-2` (0.5rem) is off the density ramp → inline-style offset. */}
            <Pin
              to="left"
              decorative
              style={{ left: "0.5rem" }}
              className="size-3.5 text-muted-foreground"
            >
              <Icon icon={searchIcon} className="size-3.5" />
            </Pin>
            <ControlSizeProvider size="sm">
              <Input
                placeholder="Search..."
                // eslint-disable-next-line spacing/no-adhoc-spacing -- precise left padding clearing the absolutely-positioned search icon
                className="pl-7"
                disabled
              />
            </ControlSizeProvider>
          </div>
          <Text
            as="p"
            variant="caption"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- top offset separating the empty-state text from the search input above
            className="mt-1.5 text-center text-muted-foreground/60"
          >
            No items
          </Text>
        </div>

        <div className="p-xs">
          <Row size="sm" disabled icon={<Icon icon={addIcon} />}>
            Create custom plugin
          </Row>
        </div>
      </Stack>
    </InlinePopover>
  );
}
