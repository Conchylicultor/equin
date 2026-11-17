import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { pagePort } from "../../core";

const readPagePort = (): number => pagePort(window.location);

/**
 * The port this page talks to its gateway on — its own (`pagePort`), read
 * while rendering through render-mode, so a static render with no page to
 * read fails loudly instead of standing in a port.
 */
export function usePagePort(): number {
  return useBrowserValue({ name: "page-port", read: readPagePort });
}
