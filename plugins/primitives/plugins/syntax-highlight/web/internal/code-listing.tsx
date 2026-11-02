import { useEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import type { ShikiTransformer } from "shiki";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { languageForPath, SHIKI_LANGS } from "./lang";
import { useDarkMode } from "./use-dark-mode";
import { useHighlightedHtml } from "./use-highlighted-html";
import { codeBackground } from "./highlighter";

/**
 * - `block` — a bounded, muted code block inside flowing content (a transcript
 *   entry): its own scroll box capped at 280px.
 * - `pane` — the whole surface of a viewer: its own scroll box filling the
 *   host's height, painted with the highlight theme's background — so the code's
 *   colour reaches the pane's bottom edge, and shows in the overscroll bounce
 *   (which moves a viewport's content, revealing the viewport's own paint).
 */
export type CodeListingVariant = "block" | "pane";

export interface CodeListingProps {
  /** The code itself (never `cat -n` output — strip its gutter first). */
  code: string;
  /** The file the code is from; its extension picks the language. */
  path: string;
  /** The line number of `code`'s first line (default 1). */
  startLine?: number;
  /** A line number (in the same numbering) to highlight and scroll into view. */
  highlightLine?: number;
  variant?: CodeListingVariant;
  /** What an empty `code` renders as (default "(empty)"). */
  emptyText?: string;
}

function makeLineNumberTransformer(startLine: number): ShikiTransformer {
  return {
    line(node, lineIdx) {
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: { class: "ln" },
        children: [{ type: "text", value: String(startLine + lineIdx - 1) }],
      });
    },
  };
}

function makeHighlightTransformer(
  startLine: number,
  targetLine: number,
): ShikiTransformer {
  return {
    line(node, lineIdx) {
      const lineNum = startLine + lineIdx - 1;
      node.properties["data-line"] = String(lineNum);
      if (lineNum === targetLine) node.properties["data-highlighted"] = "";
    },
  };
}

const HIGHLIGHT_STYLE =
  "<style>.shiki .line[data-highlighted]{background-color:rgba(250,200,50,0.18);display:block;width:100%}</style>";
const withHighlightStyle = (out: string) => `${HIGHLIGHT_STYLE}${out}`;

// Every `[&>pre]:` / `[&_.ln]:` class below styles markup shiki injects through
// dangerouslySetInnerHTML — we never hold those elements, so no primitive can
// wrap them. `[&_.ln]` is the line-number gutter.

/**
 * The surface a `pane` listing draws on: a scroll box filling its host's
 * height, painted with the highlight theme's background. Exported so a
 * viewer's own states before the listing (loading the file) sit on the same
 * colour, and the pane never flashes the app's.
 */
export function CodePaneSurface({
  ref,
  className,
  children,
  html,
}: {
  ref?: Ref<HTMLElement>;
  className?: string;
  children?: ReactNode;
  html?: string;
}) {
  const dark = useDarkMode();
  return (
    <Scroll
      ref={ref}
      axis="both"
      style={{ backgroundColor: codeBackground(dark) }}
      className={className ? `h-full ${className}` : "h-full"}
      {...(html !== undefined
        ? { dangerouslySetInnerHTML: { __html: html } }
        : { children })}
    />
  );
}

/**
 * Code with syntax highlighting and a line-number gutter — the one listing
 * behind a transcript's Read result and a file viewer's Code tab. Until the
 * highlight lands (or if it fails) the plain code shows, never a blank box.
 */
export function CodeListing({
  code,
  path,
  startLine = 1,
  highlightLine,
  variant = "block",
  emptyText = "(empty)",
}: CodeListingProps) {
  const dark = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);

  const lang = languageForPath(path);
  const resolvedLang = SHIKI_LANGS.includes(lang) ? lang : "text";

  // Stable per (startLine, highlightLine) so the shared highlight effect only
  // re-runs on real input changes.
  const transformers = useMemo<ShikiTransformer[]>(() => {
    const t = [makeLineNumberTransformer(startLine)];
    if (highlightLine != null)
      t.push(makeHighlightTransformer(startLine, highlightLine));
    return t;
  }, [startLine, highlightLine]);

  const { html } = useHighlightedHtml(code, resolvedLang, {
    dark,
    transformers,
    postProcess: highlightLine != null ? withHighlightStyle : undefined,
  });

  useEffect(() => {
    if (highlightLine == null || !containerRef.current) return;
    const el =
      containerRef.current.querySelector<HTMLElement>("[data-highlighted]");
    revealElement(el, { block: "center", behavior: "smooth" });
  }, [highlightLine, html]);

  if (!code) {
    const empty = (
      <Text
        as="p"
        variant="caption"
        className={`${variant === "pane" ? "px-md " : ""}py-xs italic text-muted-foreground`}
      >
        {emptyText}
      </Text>
    );
    return variant === "pane" ? (
      <CodePaneSurface>{empty}</CodePaneSurface>
    ) : (
      empty
    );
  }

  if (html === null) {
    return variant === "pane" ? (
      <ContentScope>
        <CodePaneSurface>
          <pre
            // eslint-disable-next-line text/no-adhoc-typography -- leading-5 fixes mono code line-height for line-number gutter alignment, distinct from caption's tighter line-height
            className="whitespace-pre-wrap break-words p-md font-mono text-caption leading-5"
          >
            {code}
          </pre>
        </CodePaneSurface>
      </ContentScope>
    ) : (
      <ContentScope>
        <Scroll
          as="pre"
          axis="both"
          className="max-h-[280px] rounded-md bg-muted p-md font-mono text-caption"
        >
          <code>{code}</code>
        </Scroll>
      </ContentScope>
    );
  }

  return (
    <ContentScope>
      {variant === "pane" ? (
        <CodePaneSurface
          ref={containerRef}
          // eslint-disable-next-line text/no-adhoc-typography -- [&>pre]:leading-5 fixes mono code line-height for line-number gutter alignment
          className="[&>pre]:min-h-full [&>pre]:w-max [&>pre]:min-w-full [&>pre]:p-md [&>pre]:font-mono [&>pre]:text-caption [&>pre]:leading-5 [&_.ln]:inline-block [&_.ln]:w-11 [&_.ln]:pr-lg [&_.ln]:select-none [&_.ln]:text-right [&_.ln]:text-muted-foreground/50 [&_.ln]:tabular-nums"
          html={html}
        />
      ) : (
        <Scroll
          ref={containerRef}
          axis="both"
          // eslint-disable-next-line layout/no-adhoc-layout -- `[&>pre]:overflow-auto` is a child-pre clip targeted via arbitrary variant on dangerouslySetInnerHTML output; not expressible through Stack/Inset/Scroll on the child
          className="max-h-[280px] [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:bg-muted [&>pre]:p-md [&>pre]:font-mono [&>pre]:text-caption [&_.ln]:inline-block [&_.ln]:w-11 [&_.ln]:pr-lg [&_.ln]:select-none [&_.ln]:text-right [&_.ln]:text-muted-foreground/50 [&_.ln]:tabular-nums"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </ContentScope>
  );
}
