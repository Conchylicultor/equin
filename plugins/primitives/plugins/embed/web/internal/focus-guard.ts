import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { isEmbeddedDocument, isFramedDocument } from "./embed-document";

/**
 * A framed embed never pulls focus out of its host page.
 *
 * A same-origin iframe calling `element.focus()` moves the TOP window's focus
 * into the frame — so an embedded app that focuses a field as it mounts (the
 * browser app's new-tab search, every `autoFocus`) blurs whatever the host was
 * doing the moment its frame finishes loading: an open popover closes, the
 * host's keyboard shortcuts go deaf. The prototype canvas framing the real app
 * beside a mock is where it bit (its Options popover shut itself as the Real
 * app frame loaded).
 *
 * So, in a framed embed only, `focus()` is a no-op while this document does not
 * have focus. Once the person clicks into the frame it does, and focus behaves
 * as anywhere else. One guard at the document boundary covers every focus call
 * site — present and future — instead of each one asking whether it is framed.
 */
export const embedFocusGuard: NonNullable<
  PluginDefinition["register"]
>[number] = {
  register() {
    if (!isEmbeddedDocument() || !isFramedDocument()) return;
    guardFocus(HTMLElement.prototype);
    guardFocus(SVGElement.prototype);
  },
};

function guardFocus(proto: HTMLElement | SVGElement): void {
  const focus = proto.focus;
  proto.focus = function (this: HTMLElement | SVGElement, options) {
    if (!document.hasFocus()) return;
    focus.call(this, options);
  };
}
