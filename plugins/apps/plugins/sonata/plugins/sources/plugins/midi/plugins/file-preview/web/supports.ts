import type { RendererMatch } from "@plugins/primitives/plugins/file-viewer/web";
import {
  fileExtension,
  type FileRef,
} from "@plugins/primitives/plugins/file-viewer/core";

const MIDI_EXTENSIONS = new Set(["mid", "midi"]);

/**
 * The MIDI renderer is the native view of a `.mid` / `.midi` file, whichever
 * source holds it: its bytes are file-viewer's `file-viewer.bytes`, which reads
 * a host file and a workspace file (on disk or as of a ref) alike.
 */
export function supportsMidi(file: FileRef): RendererMatch {
  return MIDI_EXTENSIONS.has(fileExtension(file.path)) ? "native" : false;
}
