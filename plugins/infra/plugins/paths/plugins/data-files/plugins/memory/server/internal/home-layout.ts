import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/**
 * The hidden folder of the browser's file system the apps' data dirs sit in —
 * named as the desktop's data root is (`paths`' `DATA_DIR_NAME`), so a file
 * has the same path under `~` on either host.
 */
export const DATA_FOLDER = `.${PRODUCT_NAME}`;

/** Where a data dir (`apps/prototypes`) is in the browser's file system. */
export function browserLocationOf(dir: string): FileLocation {
  return { fs: "browser", path: `~/${DATA_FOLDER}/${dir}` };
}
