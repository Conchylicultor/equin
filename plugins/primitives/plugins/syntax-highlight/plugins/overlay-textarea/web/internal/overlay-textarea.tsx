import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Clip,
  clipClasses,
} from "@plugins/primitives/plugins/css/plugins/clip/web";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";
import type React from "react";

export interface OverlayTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Renders `text` decorated — spans with classes around its characters. It
   * must render exactly `text`'s characters, in order, adding and dropping
   * none: the caret sits over these glyphs, so any other text puts it beside
   * the wrong character. Colour, weight-neutral styling and underlines only —
   * a decoration that changes a glyph's advance (bold in a font whose bold is
   * wider, a different font size, padding) drifts the caret the same way.
   */
  decorate: (text: string) => React.ReactNode;
  placeholder?: string;
  ariaLabel: string;
  /** Box chrome (border, background, radius, focus ring) — never metrics. */
  className?: string;
}

/**
 * Text-metric contract: the transparent textarea and the decorated underlay
 * must share font, size, line-height, padding, wrapping and tab-size EXACTLY,
 * or the visible caret drifts away from the coloured glyphs. Both layers take
 * this one class, so there is nothing to keep in step by hand.
 * `whitespace-pre-wrap` + `break-words` make long lines wrap identically in
 * both, so the box grows vertically and never scrolls horizontally.
 */
const METRICS = cn(
  "px-md py-sm",
  textVariantClass("code"),
  "whitespace-pre-wrap break-words [tab-size:2]",
);

/**
 * What the underlay appends after the decorated text so it occupies as many
 * lines as the textarea does.
 *
 * A textarea gives a trailing newline its own (empty) line and puts the caret
 * on it. A `<pre>` does not: a line box needs something in it, so `"C\n"` lays
 * out as ONE line. Since the underlay is what sizes the box, pressing Enter at
 * the end would leave the field a line short — the caret clipped below its
 * bottom edge until the next character fills the line. A trailing space gives
 * that line something to hold.
 */
function trailer(value: string): string {
  return value.endsWith("\n") ? " " : "";
}

/**
 * An editable field whose text is drawn decorated (syntax colours, typo
 * underlines): a transparent `<textarea>` with a visible caret laid exactly
 * over an `aria-hidden` underlay `<pre>` that renders `decorate(value)`.
 *
 * The underlay is in flow and the textarea is a full-bleed layer over it, so
 * the underlay SIZES the box: the field grows line by line as the user types
 * (or as long lines wrap), with no measuring and no `rows`. When empty, the
 * underlay holds the placeholder invisibly, so the box is as tall as the hint
 * the textarea shows.
 */
export function OverlayTextarea({
  value,
  onChange,
  decorate,
  placeholder,
  ariaLabel,
  className,
}: OverlayTextareaProps) {
  return (
    <Clip className={cn("relative", className)}>
      <pre aria-hidden className={METRICS}>
        {value === "" ? (
          // Sizes the empty field to the hint; a lone space keeps one line.
          <span className="invisible">{placeholder || " "}</span>
        ) : (
          <>
            {decorate(value)}
            {trailer(value)}
          </>
        )}
      </pre>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        // The interactive full-bleed layer laid exactly over the sizing
        // underlay. `layerClasses()` (not `<Overlay above>`, which is
        // pointer-events-none) because the layer IS this element. METRICS is
        // the caret-alignment contract.
        className={cn(
          layerClasses(),
          clipClasses({ axis: "both", fill: false }),
          "h-full w-full resize-none border-0 bg-transparent outline-none",
          "text-transparent caret-foreground placeholder:text-muted-foreground",
          METRICS,
        )}
      />
    </Clip>
  );
}
