import { useState, type ReactElement, type ReactNode } from "react";
import type { TagRow, TagTree } from "@plugins/tag-tree/plugins/engine/core";
import {
  useTagTree,
  useTagTreeActions,
} from "@plugins/tag-tree/plugins/engine/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { TagPickerOptions } from "../internal/types";
import { TagPickerPanel } from "./tag-picker-panel";

export interface TagPickerPopoverProps<
  Row extends TagRow = TagRow,
> extends TagPickerOptions {
  tree: TagTree<Row>;
  /** The element that opens it (a `TagPathChip`, a `＋ Tag` button). */
  trigger: ReactElement;
}

/**
 * The tag picker in a popover anchored on `trigger`, wired to its tree: the
 * rows live (`useTagTree`), every edit through the tree's endpoints
 * (`useTagTreeActions`). A pick closes it; each open starts fresh (empty
 * query, open along the selected tag's path).
 */
export function TagPickerPopover<Row extends TagRow>({
  tree,
  trigger,
  onPick,
  ...options
}: TagPickerPopoverProps<Row>): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      width="picker"
      padding="none"
      maxHeight="xl"
      resetOnClose
    >
      <PickerBody
        tree={tree}
        {...options}
        onPick={(id) => {
          setOpen(false);
          onPick(id);
        }}
      />
    </InlinePopover>
  );
}

function PickerBody<Row extends TagRow>({
  tree,
  ...options
}: TagPickerOptions & { tree: TagTree<Row> }) {
  const result = useTagTree(tree);
  const writes = useTagTreeActions(tree);
  if (result.status === "loading") {
    return (
      <Inset pad="sm">
        <Loading variant="rows" />
      </Inset>
    );
  }
  if (result.status === "error") {
    return (
      <Inset pad="sm">
        <Text tone="destructive">{result.error.message}</Text>
      </Inset>
    );
  }
  return <TagPickerPanel tags={result.data} writes={writes} {...options} />;
}
