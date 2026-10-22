import {
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { $createImageNode } from "./image-node";
import { $createFileNode } from "./file-node";
import { isImageMime } from "./markdown";

/**
 * Upload `files` as attachments and insert each at the caret — an image as a
 * thumbnail, anything else as a file chip. With no caret (the field was never
 * focused: a "+" click, a drop on the box's chrome) they land at the end.
 *
 * The ONE path every way of attaching takes — paste, drop, the "+" picker — so
 * they cannot disagree on what a file becomes. A failed upload rejects; the
 * caller reports it. Uploads over the caller's transport (`fetchEndpoint`, its
 * `useFetchEndpoint()`), so a field inside a scope stores to that scope's host.
 */
export async function attachFiles(
  fetchEndpoint: FetchEndpoint,
  editor: LexicalEditor,
  files: readonly File[],
): Promise<void> {
  const uploaded = await Promise.all(
    files.map((file) =>
      uploadAttachment(
        fetchEndpoint,
        file,
        file.name.length > 0 ? file.name : `paste.${mimeToExt(file.type)}`,
        file.type || "application/octet-stream",
      ),
    ),
  );
  if (uploaded.length === 0) return;
  editor.update(() => {
    const nodes: LexicalNode[] = uploaded.map((att) =>
      isImageMime(att.mime)
        ? $createImageNode({ attachmentId: att.id })
        : $createFileNode({ attachmentId: att.id, filename: att.filename }),
    );
    if (!$isRangeSelection($getSelection())) $getRoot().selectEnd();
    $insertNodes(nodes);
  });
}

/**
 * The files a paste or a drop carries. A paste of a copied image usually offers
 * the same picture in several encodings — keep one (PNG when offered). A drop,
 * or a paste of files copied from the file manager, is every file.
 */
export function filesOf(data: DataTransfer, kind: "paste" | "drop"): File[] {
  const files = Array.from(data.items)
    .filter((it) => it.kind === "file")
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
  if (kind === "drop") return files;
  const images = files.filter((f) => isImageMime(f.type));
  if (images.length > 1 && images.length === files.length) {
    return [images.find((f) => f.type === "image/png") ?? images[0]!];
  }
  return files;
}

/** Whether a drag carries files (its items are unreadable until the drop). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return data !== null && Array.from(data.types).includes("Files");
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}
