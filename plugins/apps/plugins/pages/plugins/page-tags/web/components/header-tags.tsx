import { useState, type ComponentProps, type ReactElement } from "react";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  TagChipRow,
  TagPicker,
  usePageTags,
  usePageTagsEditor,
  type PageTagsEditor,
} from "@plugins/page/plugins/tags/web";
import type { PageHeaderPartProps } from "@plugins/apps/plugins/pages/plugins/page-tree/web";

const addIcon = symbol("add");
const tagIcon = symbol("label");

/**
 * The page's tags under its title (`PageDetail.UnderTitle`): the chips, in the
 * page's order, then a faint `+ Add tag`. The whole line is the picker's one
 * trigger — a chip and the `+` open the same panel, anchored under the line's
 * start so it opens under the first chip, on the title's left edge.
 *
 * Mounted only while the page HAS tags (`useHasTags`); an untagged page offers
 * `AddTagTool` in the hover row above the title instead, so a page with no
 * tags shows nothing under its title. The first tag picked there swaps that
 * tool for this line (and removing the last one swaps back), so the picker
 * closes with the swap — like a menu closing on its pick, with the result in
 * plain sight under the title.
 */
export function UnderTitleTags({ pageId }: PageHeaderPartProps) {
  const result = usePageTagsEditor(pageId);
  const [open, setOpen] = useState(false);
  // Gated by `useHasTags`, so the editor is normally ready on mount; while it
  // is not (or its read failed — reported by live-state's own surface) there
  // is nothing to edit, and no line is the one answer that claims nothing.
  return foldResource(result, {
    loading: () => null,
    error: () => null,
    ready: (editor) => (
      <TagPicker
        editor={editor}
        open={open}
        onOpenChange={setOpen}
        trigger={tagLine(editor)}
      />
    ),
  });
}

/**
 * The chips and the `+ Add tag` hint as ONE button (chips inside it are plain
 * spans, so nothing interactive nests). An element, not a component: the
 * popover clones it to merge in its trigger props. Its own inline padding is
 * zero, so the first chip sits on the title's left edge; the bottom pad spaces
 * the line from the next under-title row (the backlinks).
 */
function tagLine(editor: PageTagsEditor): ReactElement {
  return (
    <button
      type="button"
      className="group/tags block rounded-md pb-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Inline gap="sm">
        <TagChipRow tags={editor.assigned} />
        {/* Faint at rest, a step up while the line is hovered or the picker
            is open — the mockup's quiet affordance. */}
        <Inline
          gap="2xs"
          className="text-caption text-faint-foreground transition-colors group-hover/tags:text-muted-foreground group-data-[popup-open]/tags:text-muted-foreground"
        >
          <Icon icon={addIcon} className="size-3.5" />
          Add tag
        </Inline>
      </Inline>
    </button>
  );
}

/** Whether the page carries any tag — the chip row's gate. */
export function useHasTags({ pageId }: PageHeaderPartProps): boolean {
  return foldResource(usePageTags(pageId), {
    loading: () => false,
    error: (_error, stale) => (stale?.length ?? 0) > 0,
    ready: (tags) => tags.length > 0,
  });
}

/**
 * `Add tag` in the header's hover row (`PageDetail.HeaderTool`), beside Add
 * icon / Add cover: the way into the picker while the page has no tags. The
 * same quiet ghost as its neighbours — an `xs` button, caption-sized, faint.
 */
export function AddTagTool({ pageId }: PageHeaderPartProps) {
  const result = usePageTagsEditor(pageId);
  const [open, setOpen] = useState(false);
  return foldResource(result, {
    loading: () => null,
    error: () => null,
    ready: (editor) => (
      <TagPicker
        editor={editor}
        open={open}
        onOpenChange={setOpen}
        trigger={<AddTagButton />}
      />
    ),
  });
}

/**
 * The hover-row button. A component that spreads what it is handed onto the
 * `Button`, because the popover merges its trigger props into the element it
 * is given — and the density provider around the button is not a DOM node.
 */
function AddTagButton(props: ComponentProps<typeof Button>) {
  return (
    <ControlSizeProvider size="xs">
      <Button
        {...props}
        variant="ghost"
        className="text-caption font-normal text-faint-foreground"
      >
        <Icon icon={tagIcon} className="size-3.5" />
        Add tag
      </Button>
    </ControlSizeProvider>
  );
}

/** Whether the page carries no tag yet — the hover-row tool's gate. */
export function useHasNoTags({ pageId }: PageHeaderPartProps): boolean {
  return foldResource(usePageTags(pageId), {
    loading: () => false,
    error: () => false,
    ready: (tags) => tags.length === 0,
  });
}
