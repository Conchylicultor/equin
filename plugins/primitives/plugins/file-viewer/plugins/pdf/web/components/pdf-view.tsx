import {
  fileRefName,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";
import {
  UnloadedFile,
  type FileRendererProps,
} from "@plugins/primitives/plugins/file-viewer/web";
import { PdfFrame } from "@plugins/primitives/plugins/embed/plugins/frame/web";

/**
 * The file in the browser's built-in PDF viewer. host-fs serves a PDF without
 * the `sandbox` CSP it puts on every other raw file — a sandboxed document
 * cannot host the viewer.
 */
export function PdfView({ file }: FileRendererProps) {
  return (
    <PdfFrame
      asset={fileUrl(file)}
      unloaded={(src) => <UnloadedFile src={src} />}
      title={fileRefName(file)}
      className="block size-full border-0"
    />
  );
}
