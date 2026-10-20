import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { themeForMode } from "./highlighter";
import { resolveLang } from "./lang";
import { useDarkMode } from "./use-dark-mode";
import { useHighlightedHtml } from "./use-highlighted-html";

export function HighlightedCode({
  code,
  lang,
  flush,
  className,
}: {
  code: string;
  lang?: string | null;
  /**
   * Sits flush inside a frame of its own (a fence's header above it) rather than
   * as a free block in prose: no vertical rhythm margin around it.
   */
  flush?: boolean;
  className?: string;
}) {
  const dark = useDarkMode();
  const resolved = resolveLang(lang);
  // Opt into the shared module cache so a re-mount paints the cached markup with
  // the same string reference (the load-bearing stability that keeps React from
  // tearing down the `<pre>` and destroying text selection / ContentScope focus).
  const cacheKey = resolved
    ? `${themeForMode(dark)} ${resolved} ${code}`
    : null;
  const { html } = useHighlightedHtml(code, resolved, { dark, cacheKey });

  // Every class here is projected onto the <pre> SHIKI injects, through
  // dangerouslySetInnerHTML — we never hold that element, so there is nothing to
  // wrap in <Scroll>/<Card> and no component form available. `[&>pre]:m-0`
  // resets its UA margin (there is no named utility for a reset-to-zero), and
  // the metrics are the `code` role rather than a hand-spelled size+leading.
  const wrapper =
    "[&>pre]:m-0 [&>pre]:overflow-auto [&>pre]:rounded [&>pre]:bg-muted [&>pre]:p-md [&>pre]:text-code";

  if (!resolved || html === null) {
    return (
      <ContentScope>
        <Scroll
          as="pre"
          axis="both"
          // eslint-disable-next-line spacing/no-adhoc-spacing -- my-2 sets code-block vertical rhythm against surrounding content; one-off, no parent flex to own it
          className={cn(
            !flush && "my-2",
            "rounded-md bg-muted p-md font-mono text-caption",
            className,
          )}
        >
          <code>{code}</code>
        </Scroll>
      </ContentScope>
    );
  }

  return (
    <ContentScope>
      <div
        // eslint-disable-next-line spacing/no-adhoc-spacing, layout/no-adhoc-layout, radius/no-adhoc-radius -- my-2 sets code-block vertical rhythm (one-off, no parent flex to own it); every `[&>pre]:` class in `wrapper` styles shiki's injected <pre>, which this component never holds, so no primitive can wrap it
        className={cn(!flush && "my-2", wrapper, className)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </ContentScope>
  );
}
