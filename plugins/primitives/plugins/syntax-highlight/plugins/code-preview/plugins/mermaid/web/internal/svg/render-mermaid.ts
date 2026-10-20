import mermaid from "mermaid";

export type MermaidRender =
  { ok: true; svg: string } | { ok: false; message: string };

let sequence = 0;
// mermaid's configuration is module-global and `render` measures in a shared
// scratch element, so two diagrams rendering at once would race each other's
// theme. One chain serializes every render on the page.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Renders one diagram to SVG, themed by `themeVariables`. A source mermaid
 * rejects is a result, not a throw — the preview shows its message — while
 * anything that is not mermaid's own Error still throws.
 */
export function renderMermaid(
  source: string,
  themeVariables: Record<string, string | boolean>,
): Promise<MermaidRender> {
  const run = queue.then(() => renderNow(source, themeVariables));
  queue = run.catch((err: unknown) => {
    // The chain only orders renders; the caller of `run` sees the failure.
    if (err instanceof Error) return;
    throw err;
  });
  return run;
}

async function renderNow(
  source: string,
  themeVariables: Record<string, string | boolean>,
): Promise<MermaidRender> {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables,
  });
  const id = `mermaid-preview-${++sequence}`;
  try {
    await mermaid.parse(source);
    const { svg } = await mermaid.render(id, source);
    return { ok: true, svg: naturalWidth(svg) };
  } catch (err) {
    if (err instanceof Error) return { ok: false, message: err.message };
    // mermaid's parser throws plain objects ({ str, hash }) for syntax errors.
    if (typeof err === "object" && err !== null && "str" in err) {
      return { ok: false, message: String((err as { str: unknown }).str) };
    }
    throw err;
  } finally {
    // A failed render can leave its scratch container in <body>.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

/**
 * Mermaid writes `width="100%"` plus `max-width: <natural>px`, which in a box
 * sized by its content resolves to almost nothing. Give the SVG its natural
 * width instead; a wider-than-frame diagram then scrolls.
 */
function naturalWidth(svg: string): string {
  const max = /max-width:\s*([\d.]+)px/.exec(svg);
  if (!max) return svg;
  return svg.replace(/^(<svg[^>]*?)\swidth="100%"/, `$1 width="${max[1]}"`);
}
