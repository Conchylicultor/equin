import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";

// mermaid is a multi-megabyte package: code-split it off the eager plugin-boot
// wave, so it loads on the first diagram of the session.
export const MermaidPreview = lazyComponent<{ source: string }>(
  () =>
    import("./mermaid-preview-impl").then((m) => ({
      default: m.MermaidPreview,
    })),
  { fallback: null },
);
