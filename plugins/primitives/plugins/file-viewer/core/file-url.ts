import { codeImageUrl } from "@plugins/code-explorer/plugins/code-api/core";
import { hostFileUrl } from "@plugins/infra/plugins/host-fs/core";
import type { FileRef } from "./file-ref";

/**
 * The URL the browser reads a file's raw bytes from — for an `<img>`, an
 * `<iframe>`, a download. Dispatches on where the file lives so a renderer
 * never does: a host file through host-fs's raw route, a workspace file through
 * code-api's (as of `ref` when the ref names one). The workspace route serves
 * image formats only today; a host file is any file.
 */
export function fileUrl(file: FileRef): string {
  switch (file.source) {
    case "host":
      return hostFileUrl(file.path);
    case "workspace":
      return codeImageUrl(
        file.workspace,
        file.path,
        file.ref !== undefined ? { ref: file.ref } : {},
      );
  }
}
