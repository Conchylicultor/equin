/**
 * Whether a DOM node sits in a toast — so a surface that closes on a press
 * outside itself can leave a press on a toast alone (a toast's Undo is about
 * the very thing the surface shows).
 */
export function isInToast(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest("[data-sonner-toaster]") != null;
}
