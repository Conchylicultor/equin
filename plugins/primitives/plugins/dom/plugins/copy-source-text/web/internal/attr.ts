/**
 * How an element declares **what it copies as**.
 *
 * The clipboard's plain-text flavour is built by walking the rendered DOM, so
 * by default you can only copy what is on screen — and a rendering that
 * SUBSTITUTED something for its source text has no way to give the source back.
 * Two consequences, both of which this attribute answers:
 *
 * - An active-data chip replaced the characters the agent actually wrote
 *   (`` `control-panel` ``, `conv-1777406728-mb12`) with a widget. Copying the
 *   sentence around it yields the chip's label, stripped of the backticks that
 *   made it a chip — so the text does not round-trip back into a prompt.
 * - A chip's label lives in its own box (a flex item, which CSS blockifies), and
 *   the serializer puts a newline before and after every block-level box. So a
 *   chip mid-sentence copies as three lines.
 *
 * Both are the same missing fact: the element knows what it stands for, and the
 * clipboard does not. Declaring it here is what lets
 * `primitives/dom/copy-source-text`'s handler put the source text back.
 */
export const COPY_SOURCE_ATTR = "data-copy-text";

/** The declaration, as props to spread onto the element it describes. */
export type CopySourceProps = { readonly [COPY_SOURCE_ATTR]: string };

/**
 * "Copy me as this text" — for an element that STANDS IN for something the
 * reader can no longer see.
 *
 * The argument is the source verbatim, punctuation included: a chip minted from
 * an inline code span declares `` `control-panel` ``, backticks and all, because
 * that is what the markdown said before it was rendered away.
 */
export function copiesAsText(source: string): CopySourceProps {
  return { [COPY_SOURCE_ATTR]: source };
}

/**
 * "Copy me as the text I already show, unbroken" — for an element that
 * substitutes nothing and only wants out of the newline.
 *
 * An empty declaration rather than a second attribute: the handler's rule is
 * "replace this element with its declared text", and an element with nothing to
 * declare falls back to its own `textContent`. Every `Badge` says this, which is
 * what keeps a status chip in a table row from splitting the row across three
 * lines when the row is copied.
 */
export const copiesAsOwnText: CopySourceProps = { [COPY_SOURCE_ATTR]: "" };
