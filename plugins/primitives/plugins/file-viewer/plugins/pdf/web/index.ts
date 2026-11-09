import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { fileExtension } from "@plugins/primitives/plugins/file-viewer/core";
import { FileViewer } from "@plugins/primitives/plugins/file-viewer/web";
import { PdfView } from "./components/pdf-view";

export default {
  description:
    "PDF preview for .pdf files in any file system, in the browser's own PDF viewer (pages, zoom, search, print).",
  contributions: [
    FileViewer.Renderer({
      id: "pdf",
      label: "PDF",
      // Every file system serves a PDF's bytes (`fileUrl`).
      supports: ({ file }) =>
        fileExtension(file.path) === "pdf" ? "native" : false,
      component: PdfView,
    }),
  ],
} satisfies PluginDefinition;
