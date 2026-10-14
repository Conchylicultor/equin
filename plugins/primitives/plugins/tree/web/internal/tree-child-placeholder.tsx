import type { ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { ChildPlaceholder } from "../../core";
import { TreeGuides } from "./tree-guides";
import { treeRowIndentStyle } from "./tree-indent";

/**
 * The placeholder child row: indented one level below its parent and aligned to
 * the label column (past the chevron slot), so it reads as the parent's content
 * rather than as a sibling. Same height invariant as `TreeRowChrome`.
 */
export function TreeChildPlaceholder({
  placeholder,
  depth,
  guides = false,
}: {
  placeholder: ChildPlaceholder;
  /** The depth of the CHILD row (parent depth + 1). */
  depth: number;
  /** Draw the indent guides its sibling rows draw (`TreeListProps.guides`). */
  guides?: boolean;
}): ReactNode {
  return (
    <Stack
      direction="row"
      align="center"
      gap="none"
      // The loading state carries its own `status` role.
      role={placeholder.kind === "failed" ? "alert" : undefined}
      data-tree-placeholder={placeholder.kind}
      // `relative`: the positioning context the guides are placed in.
      className="relative min-h-7 gap-tree-row px-xs py-xs text-body"
      // The same indent split and gap as `TreeRowChrome` — density tokens, so
      // a theme's wider step moves the placeholder (and its guides) with its
      // siblings.
      style={treeRowIndentStyle(depth)}
    >
      {guides && <TreeGuides depth={depth} />}
      {/* The chevron slot's width, so the text starts on the label column. */}
      <span className="size-5" aria-hidden />
      {placeholder.kind === "loading" ? (
        // The shared loading state (delayed, so a fast listing never flashes),
        // flush in the row: the row already owns the inset.
        <Loading
          variant="spinner"
          label="Loading…"
          className="px-none py-none"
        />
      ) : placeholder.kind === "empty" ? (
        <Text tone="faint">Empty</Text>
      ) : (
        <>
          <Fill>
            <Text tone="destructive" title={placeholder.message}>
              {placeholder.message}
            </Text>
          </Fill>
          <Button
            variant="ghost"
            aspect="inline"
            onClick={placeholder.retry}
            className="px-2xs"
          >
            Retry
          </Button>
        </>
      )}
    </Stack>
  );
}
