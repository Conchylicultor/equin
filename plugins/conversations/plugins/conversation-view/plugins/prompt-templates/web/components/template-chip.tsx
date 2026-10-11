import {
  Button,
  ButtonGroup,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const editIcon = symbol("edit");
const sendIcon = symbol("send");

/** One configured template: its chip's label and the prompt it stands for. */
export interface TemplateChipItem {
  id: string;
  title: string;
  prompt: string;
}

export interface TemplateChipProps {
  template: TemplateChipItem;
  /** ✎ name — put the prompt in the draft to edit. */
  onInsert: (t: TemplateChipItem) => void;
  /** ➤ — send it right away. */
  onSend: (t: TemplateChipItem) => void;
  /** Solid outline; unpinned (panel-only) chips are dashed. */
  pinned?: boolean;
  /** Whether ➤ is live; ✎ always is. */
  canSend: boolean;
}

/**
 * One split prompt chip: ✎ name puts the prompt in the draft, ➤ sends it — the
 * template bar's chip. Its density comes from the ambient ControlSizeProvider.
 */
export function TemplateChip({
  template,
  onInsert,
  onSend,
  pinned,
  canSend,
}: TemplateChipProps) {
  return (
    // No text class here: `Button` writes its own rung from the ambient density
    // (`buttonTextClassFor`), so a font-size on this wrapper never reaches the
    // labels — it only looked like it was doing something.
    <ButtonGroup className={cn(!pinned && "[&>*]:border-dashed")}>
      <Button
        variant="outline"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onInsert(template)}
      >
        <Icon icon={editIcon} className="size-3" />
        <span>{template.title}</span>
      </Button>
      {/* eslint-disable-next-line icon-button/prefer-icon-button -- the send half of a ButtonGroup template chip, not a standalone action: it shares the chip's outline seam and its size-3 glyph matches the label half */}
      <Button
        variant="outline"
        aria-label={`Send: ${template.title}`}
        disabled={!canSend}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSend(template)}
        // The icon-only end segment: its width is the density group's
        // `padSplitArrowX` (default the `xs` control pad) around the glyph.
        className={cn(
          "px-split-arrow",
          canSend ? "text-muted-foreground" : "text-muted-foreground/30",
        )}
      >
        <Icon icon={sendIcon} className="size-3" />
      </Button>
    </ButtonGroup>
  );
}
