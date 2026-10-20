import { useMemo } from "react";
import { CodePreview, type CodePreviewRendererContribution } from "./slots";

/**
 * The preview registered for a fence language (its canonical name or an alias,
 * case-insensitive), or `null` when the language has none — the caller then
 * shows the code as code.
 */
export function useCodePreviewRenderer(
  lang: string | null | undefined,
): CodePreviewRendererContribution | null {
  const renderers = CodePreview.Renderer.useContributions();
  return useMemo(() => {
    if (!lang) return null;
    const key = lang.toLowerCase();
    return (
      renderers.find((r) => r.lang === key || r.aliases?.includes(key)) ?? null
    );
  }, [renderers, lang]);
}

/** Every previewable language, for a language picker. */
export function useCodePreviewLangs(): ReadonlyArray<{
  lang: string;
  label: string;
}> {
  const renderers = CodePreview.Renderer.useContributions();
  return useMemo(
    () => renderers.map((r) => ({ lang: r.lang, label: r.label })),
    [renderers],
  );
}
