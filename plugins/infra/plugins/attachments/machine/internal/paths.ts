import { extname } from "node:path";
import { attachmentsDir } from "../../data-dirs";

export async function ensureAttachmentsRoot(): Promise<string> {
  return attachmentsDir.ensure();
}

export function diskPathFor(id: string, filename: string): string {
  const ext = extname(filename).toLowerCase() || ".bin";
  return attachmentsDir.file(`${id}${ext}`);
}
