/**
 * The title a task is filed with before (or instead of) a generated one: the
 * first line of its description, clipped to 80 characters. Pure, so every host
 * files tasks the same way.
 */
export function synthesiseTitleFallback(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
