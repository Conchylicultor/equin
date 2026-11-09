import type { RendererMatch } from "@plugins/primitives/plugins/file-viewer/web";
import { fileExtension } from "@plugins/primitives/plugins/file-viewer/core";
import type { FileLocation } from "@plugins/infra/plugins/paths/plugins/file-systems/core";

const MIDI_EXTENSIONS = new Set(["mid", "midi"]);

/**
 * The MIDI renderer is the native view of a `.mid` / `.midi` file, whichever
 * file system holds it: its bytes are file-systems' `useFileBytes`, which
 * reads every one alike.
 */
export function supportsMidi(file: FileLocation): RendererMatch {
  return MIDI_EXTENSIONS.has(fileExtension(file.path)) ? "native" : false;
}
