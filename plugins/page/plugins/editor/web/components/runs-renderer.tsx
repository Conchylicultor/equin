import { Fragment, type CSSProperties, type ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { matchTokens } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { colorCssValue, runsOf, type RichText, type TextRun } from "../../core";
import { blockTextRenderableExtensions } from "../internal/block-text-extensions";

/**
 * Faithful, non-editable rendering of the editor's `RichText` runs model.
 *
 * Mirrors the editor's runs→Lexical mapping (`block-text-extensions.ts`) without
 * mounting Lexical:
 *  - marks: bold→`<strong>`, italic→`<em>`, underline/strikethrough/code→the same
 *    class strings the live editor's Lexical theme applies, so the visual is
 *    pixel-identical.
 *  - color: `colorCssValue(token)` → the shared `var(--rt-color-<token>)` CSS var.
 *  - link: a non-editable `<a>` styled like the editor's link theme.
 *  - inline TOKENS — a page link, a date mention, inline math, an agent id —
 *    through the registry, never by name. See {@link segmentsOf}.
 *
 * The mark class strings are duplicated from the editor's Lexical `theme.text`
 * config rather than imported (they live inside a Lexical config object, not an
 * exported value); they are the inline-format contract and change in lockstep
 * with that config.
 */

/**
 * Marks a rendered inline token as ONE atomic leaf of the text's linear offset
 * basis, carrying the length of its spelling (`static-text-geometry.ts`).
 */
export const TOKEN_LENGTH_ATTR = "data-token-length";

// Lexical theme.text mark classes (block-text-editor.tsx initialConfig.theme).
const MARK_UNDERLINE = "underline";
const MARK_STRIKETHROUGH = "line-through";
const MARK_CODE = "rounded-md bg-muted px-xs font-mono text-[0.9em]";
// Lexical theme.link.
const LINK_CLASS = "text-primary-text underline";

/** One piece of a run: plain characters, or a token the registry recognized. */
type Segment =
  | { kind: "text"; text: string }
  | { kind: "token"; text: string; render: () => ReactNode };

/**
 * Split a run's text into plain spans + recognized inline tokens.
 *
 * The scan is `matchTokens` — the very walk the editor's own runs→Lexical seed
 * runs — over the very registry the editor reads, so the read-only split and the
 * editable split are ONE function over ONE set. This file used to hardcode
 * exactly two token types and race their two regexes, which is why `[[date:…]]`
 * showed up as literal brackets on every read-only surface for as long as inline
 * dates existed: nobody remembered to add the third case, and nothing could tell
 * them. There is no third case to add any more.
 *
 * Two things come for free with the shared walk. A run carrying the `code` mark
 * yields no tokens at all, so `` `att-…` `` written as inline code stays code
 * here exactly as it does in the editor. And a token whose family renders
 * `null` — the chip is not in this composition — falls back to its raw
 * characters, which is what the Lexical decorator does too.
 *
 * A token family that is not registered at all is not matched, so its token
 * stays plain text. That is the honest answer on a surface composed without it.
 */
function segmentsOf(
  text: string,
  marks: readonly string[] | undefined,
): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const match of matchTokens(
    text,
    marks,
    blockTextRenderableExtensions(),
  )) {
    if (match.start > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, match.start) });
    }
    out.push({
      kind: "token",
      text: match.text,
      render: () => match.extension.renderToken(match.match),
    });
    cursor = match.end;
  }
  if (cursor < text.length) {
    out.push({ kind: "text", text: text.slice(cursor) });
  }
  return out;
}

/** Render a plain-text segment, preserving `\n` soft breaks as `<br>`. */
function renderText(text: string): ReactNode {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}

/** Wrap a run's rendered children with its marks/color/link. */
function decorateRun(run: TextRun, children: ReactNode): ReactNode {
  const marks = run.marks ?? [];
  // NOTE: `underline` and `line-through` are both `text-decoration-line`
  // utilities, so routing them through `cn()` (twMerge) would collapse to the
  // last one — silently dropping underline when a run is BOTH underlined and
  // struck. The live editor applies them as independent Lexical classes (no
  // twMerge) and CSS happily renders `text-decoration: underline line-through`.
  // So we join the decoration classes by hand and only `cn()` the non-colliding
  // `code` chrome.
  const className = [
    marks.includes("underline") && MARK_UNDERLINE,
    marks.includes("strikethrough") && MARK_STRIKETHROUGH,
    marks.includes("code") && MARK_CODE,
  ]
    .filter(Boolean)
    .join(" ");
  const colorValue = colorCssValue(run.color);
  const style: CSSProperties | undefined = colorValue
    ? { color: colorValue }
    : undefined;

  let node: ReactNode = children;
  if (marks.includes("italic")) node = <em>{node}</em>;
  if (marks.includes("bold")) node = <strong>{node}</strong>;

  if (run.link) {
    return (
      <a
        href={run.link}
        target="_blank"
        rel="noreferrer"
        className={cn(LINK_CLASS, className)}
        style={style}
      >
        {node}
      </a>
    );
  }
  if (className || style) {
    return (
      <span className={className || undefined} style={style}>
        {node}
      </span>
    );
  }
  return node;
}

export interface RunsRendererProps {
  /** A `RichText` array, or any `string | RichText | unknown` (coerced via `runsOf`). */
  value: unknown;
}

/** Faithfully renders the editor's rich-text runs as static React. */
export function RunsRenderer({ value }: RunsRendererProps) {
  const runs: RichText = runsOf(value);
  return (
    <>
      {runs.map((run, ri) => {
        const segments = segmentsOf(run.text, run.marks);
        const children = segments.map((seg, si) => {
          if (seg.kind === "token") {
            // A family answering `null` does not claim these characters after
            // all — paint the raw token, never nothing.
            const rendered = seg.render();
            // An atomic leaf of the linear offset basis: the token counts as
            // its whole spelling, whatever its chip draws — the same length
            // Lexical's decorator node reports. `static-text-geometry.ts`
            // walks text by these marks, so a caret or span over this DOM
            // lands at the offsets the live editor would.
            //
            // `select-none`: a selection across the line passes over the chip
            // as one object, never highlighting its label's characters — what
            // the live editor's `TokenFrame` does for the same token.
            return (
              <span
                key={si}
                className="select-none"
                {...{ [TOKEN_LENGTH_ATTR]: seg.text.length }}
              >
                {rendered ?? renderText(seg.text)}
              </span>
            );
          }
          return <Fragment key={si}>{renderText(seg.text)}</Fragment>;
        });
        return <Fragment key={ri}>{decorateRun(run, children)}</Fragment>;
      })}
    </>
  );
}
