import { stat } from "node:fs/promises";
import { SHELL_OUTPUT_TAIL_BYTES, type ShellOutput } from "../../core";

/**
 * The window's text, starting at a line boundary.
 *
 * A window that did not start at byte 0 begins mid-line (and possibly
 * mid-character), so everything up to and including its first line break is
 * dropped. A `\r` counts: a progress bar's frames are `\r`-separated. A window
 * with no break in it at all is one enormous line, kept whole rather than
 * dropped to nothing.
 */
export function cutAtLineBoundary(
  text: string,
  startedMidFile: boolean,
): string {
  if (!startedMidFile) return text;
  const match = /[\r\n]/.exec(text);
  return match === null ? text : text.slice(match.index + 1);
}

/**
 * The last {@link SHELL_OUTPUT_TAIL_BYTES} of a shell's output file: one `stat`
 * and one bounded read, however large the file has grown. `gone` when the file
 * is not there (tmp was cleaned, or the machine rebooted).
 */
export async function readShellTail(
  path: string,
): Promise<Extract<ShellOutput, { kind: "present" | "gone" }>> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "gone" };
    throw err;
  }
  const start = Math.max(0, size - SHELL_OUTPUT_TAIL_BYTES);
  const text = await Bun.file(path).slice(start, size).text();
  return {
    kind: "present",
    size,
    tail: cutAtLineBoundary(text, start > 0),
    truncated: start > 0,
  };
}
