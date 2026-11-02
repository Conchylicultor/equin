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
  className,
}: {
  code: string;
  lang?: string | null;
  /** The block carries no outer space of its own: its container spaces it (a
   *  Stack gap), and prose gives it its flow role (`my-flow-block`, as
   *  markdown's fence does). */
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
  // wrap in <Scroll>/<Card> and no component form available. Its UA margin
  // is already zeroed by preflight, and the metrics are the `code` role rather than a hand-spelled size+leading.
  //
  // `clear-both`: a scroll box cannot wrap around a float (a transcript row's
  // floated action strip) — beside one it is narrowed for its whole height,
  // hiding code behind a blank column. It starts below the float instead.
  const wrapper =
    "clear-both [&>pre]:overflow-auto [&>pre]:rounded [&>pre]:bg-muted [&>pre]:p-md [&>pre]:text-code";

  if (!resolved || html === null) {
    return (
      <ContentScope>
        <Scroll
          as="pre"
          axis="both"
          className={cn(
            "clear-both rounded-md bg-muted p-md font-mono text-caption",
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
        // eslint-disable-next-line layout/no-adhoc-layout, radius/no-adhoc-radius -- every `[&>pre]:` class in `wrapper` styles shiki's injected <pre>, which this component never holds, so no primitive can wrap it
        className={cn(wrapper, className)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </ContentScope>
  );
}
