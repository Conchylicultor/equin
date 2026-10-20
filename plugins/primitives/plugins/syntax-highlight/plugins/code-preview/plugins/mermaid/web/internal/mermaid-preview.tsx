import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";

// The preview (parser + native renderers) loads on the first diagram of the
// session; the flowchart layout engine and Mermaid itself split further, each
// loading only when a diagram needs it.
export const MermaidPreview = lazyComponent<{ source: string }>(
  () =>
    import("./mermaid-preview-impl").then((m) => ({
      default: m.MermaidPreview,
    })),
  { fallback: null },
);
