import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: a mermaid fence reaches its preview through the
// CodePreview.Renderer slot, so it needs the running app.
export default [
  appExhibit({
    id: "mermaid/native-diagrams",
    label: "Native Mermaid diagrams (sequence + flowchart)",
    widths: [720, 1120],
    load: () => import("./internal/native-diagrams"),
  }),
];
