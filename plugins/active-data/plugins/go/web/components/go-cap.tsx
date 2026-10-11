import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { symbol, type SymbolRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

export const sendIcon = symbol("play-arrow");
export const editIcon = symbol("edit");
export const removeIcon = symbol("close");

/** The tint a block Go wears — the reply's card and the sent message's alike. */
export const GO_TINT = "bg-primary/5";

/**
 * An inline Go's box: the prompt templates' chip colours (the outline button's
 * `outline-fill` / `outline-border` / `outline-hover` palette tokens) at inline
 * `code`'s padding — so a Go reads as the same control as the template chips,
 * at the height of the `code` spans beside it. Applied to EACH half: padding
 * and borders on a child are not covered by its parent's background.
 */
export const GO_INLINE_BOX =
  "bg-outline-fill border-y border-outline-border p-inline-code";
/** The hover of an inline Go's actionable half. */
export const GO_INLINE_HOVER =
  "hover:bg-outline-hover hover:text-outline-hover-foreground";

interface CapProps {
  icon: SymbolRef;
  label: string;
  onAction: () => void;
  disabled?: boolean;
}

/** Button behaviour for an inline span: click, Enter / Space, no focus steal. */
function buttonHandlers({
  onAction,
  disabled,
}: {
  onAction: () => void;
  disabled?: boolean;
}) {
  const fire = () => {
    if (!disabled) onAction();
  };
  return {
    role: "button",
    tabIndex: disabled ? -1 : 0,
    // Keeps the prompt's caret (and a reply's selection) where it was.
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      fire();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      fire();
    },
  } as const;
}

const capTone = (disabled: boolean | undefined) =>
  disabled
    ? "cursor-default text-muted-foreground/30"
    : cn("cursor-pointer text-muted-foreground", GO_INLINE_HOVER);

/**
 * The action half of an inline Go — `[text | ▶]`. A plain INLINE span, not a
 * button: an inline box with the text's own font size is exactly as tall as
 * the tinted text it closes (an inline-block's box is the line height, which
 * made the two halves misalign), and it wraps with the text. Both halves wear
 * `GO_INLINE_BOX`, so they stay flush; the cap's left hairline is the seam.
 */
export function GoCap(props: CapProps) {
  return (
    <span
      {...buttonHandlers(props)}
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      title={props.label}
      className={cn(
        "select-none rounded-r-inline-code border-x box-decoration-clone",
        GO_INLINE_BOX,
        capTone(props.disabled),
      )}
    >
      {/* Centred on the tinted box, not on the letters: an inline background
          covers the font's ascent + descent, whose middle is (ascent −
          descent) / 2 ≈ 0.36em above the baseline for Inter; the icon's box
          sits half its own height (6px) below that. `middle` — half the
          x-height — sits it low. */}
      <Icon
        icon={props.icon}
        active
        className="inline size-3 align-[calc(0.36em_-_6px)]"
      />
    </span>
  );
}

/** One segment of a block Go's right-hand rail (✎ over ▶). */
export function GoRailCap(props: CapProps) {
  return (
    <Center
      as="span"
      {...buttonHandlers(props)}
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      title={props.label}
      className={cn(
        growClass(),
        "select-none bg-foreground/5 px-sm [&+&]:border-t [&+&]:border-foreground/10",
        capTone(props.disabled),
      )}
    >
      <Icon icon={props.icon} active className="size-3" />
    </Center>
  );
}

/**
 * An inline Go: the text and, when it has one, its cap — one unit, in the
 * template chip's colours.
 * `onEdit` makes the text itself the edit half (click it to put it in the
 * draft); without a cap the tint closes on its own.
 */
export function GoInlineUnit({
  children,
  onEdit,
  cap,
}: {
  children: ReactNode;
  onEdit?: () => void;
  cap?: ReactNode;
}) {
  const textBox = cn(
    "box-decoration-clone",
    GO_INLINE_BOX,
    cap ? "rounded-l-inline-code border-l" : "rounded-inline-code border-x",
  );
  return (
    <span>
      {onEdit ? (
        <span
          {...buttonHandlers({ onAction: onEdit })}
          // Selecting the words must stay possible: no mousedown capture, and a
          // click that ends a selection is not an edit.
          onMouseDown={undefined}
          onClick={(e) => {
            if (String(window.getSelection() ?? "")) return;
            e.stopPropagation();
            onEdit();
          }}
          title="Edit before sending"
          className={cn(textBox, "cursor-pointer", GO_INLINE_HOVER)}
        >
          {children}
        </span>
      ) : (
        <span className={textBox}>{children}</span>
      )}
      {cap}
    </span>
  );
}
