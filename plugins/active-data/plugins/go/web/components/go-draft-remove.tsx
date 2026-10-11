import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Placed } from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { $removeGoRegion } from "../internal/go-regions";
import { RAIL_WIDTH, useRail } from "../internal/go-rails";
import { GoCap, GoRailCap, removeIcon } from "./go-cap";

/**
 * The ✕ a `<go>` region wears in the draft, drawn by its close marker; it drops
 * the whole suggestion. One line closes like the reply's `[text | ▶]`, as a
 * cap; a multi-line region gets the reply card's rail, on the right edge of
 * the box `GoRegionPlugin` paints (which measures where that is).
 */
export function GoDraftRemove({ closeKey }: { closeKey: string }) {
  const [editor] = useLexicalComposerContext();
  const rail = useRail(editor, closeKey);
  const remove = () => editor.update(() => $removeGoRegion(closeKey));
  if (!rail) {
    return (
      <GoCap
        icon={removeIcon}
        label="Remove the suggestion"
        onAction={remove}
      />
    );
  }
  return (
    <Placed
      as="span"
      x={{ start: rail.left, size: RAIL_WIDTH }}
      y={{ start: rail.top, size: rail.height }}
      // Clipped so the cap's fill follows the box's rounded corner.
      className={cn(
        "rounded-r-md border-l border-foreground/10",
        clipClasses({ axis: "both", fill: false }),
      )}
    >
      <Stack as="span" gap="none" className="size-full">
        <GoRailCap
          icon={removeIcon}
          label="Remove the suggestion"
          onAction={remove}
        />
      </Stack>
    </Placed>
  );
}
