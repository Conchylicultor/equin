import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useDarkMode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { CodePreviewError } from "@plugins/primitives/plugins/syntax-highlight/plugins/code-preview/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { renderMermaid } from "./render-mermaid";
import { mermaidThemeVariables } from "./theme-variables";

type PreviewState =
  | { kind: "pending" }
  | { kind: "drawn"; svg: string; error: string | null }
  | { kind: "failed"; error: string };

/**
 * A mermaid source drawn as its diagram. While the source is being edited, a
 * source that stops parsing keeps the last diagram that did, with the error
 * under it — a half-typed arrow should not blank the picture — but the error is
 * always shown.
 */
export function MermaidSvg({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const dark = useDarkMode();
  // Typing re-renders the diagram; deferring keeps keystrokes ahead of it.
  const deferred = useDeferredValue(source);
  const [state, setState] = useState<PreviewState>({ kind: "pending" });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    void renderMermaid(deferred, mermaidThemeVariables(el, dark)).then(
      (result) => {
        if (cancelled) return;
        setState((prev) => {
          if (result.ok) return { kind: "drawn", svg: result.svg, error: null };
          return prev.kind === "drawn"
            ? { ...prev, error: result.message }
            : { kind: "failed", error: result.message };
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deferred, dark]);

  return (
    <div ref={ref}>
      {state.kind === "pending" ? (
        <Loading variant="block" />
      ) : state.kind === "failed" ? (
        <CodePreviewError label="Mermaid" message={state.error} />
      ) : (
        <>
          <Scroll axis="x" className="px-md py-sm">
            <Center axis="horizontal">
              <div
                className="[&>svg]:h-auto [&>svg]:max-w-none"
                dangerouslySetInnerHTML={{ __html: state.svg }}
              />
            </Center>
          </Scroll>
          {state.error !== null ? (
            <CodePreviewError label="Mermaid" message={state.error} />
          ) : null}
        </>
      )}
    </div>
  );
}
