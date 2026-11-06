import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

/** Bytes kept of a name — APFS names are at most 255 bytes. */
const MAX_NAME_BYTES = 200;

const SEPARATOR = " · ";

/**
 * `equin · <kind> · <id>`, as a file name: no `/`, no control characters,
 * bounded. Kind first, so a list sorted by name groups every build, every
 * agent, every server together.
 */
export function processName(kind: string, id?: string): string {
  const parts = [PRODUCT_NAME, kind, ...(id ? [id] : [])].map((p) =>
    p
      .replace(/[\u0000-\u001f\u007f/:]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const name = parts.join(SEPARATOR);
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= MAX_NAME_BYTES) return name;
  return new TextDecoder()
    .decode(bytes.slice(0, MAX_NAME_BYTES))
    .replace(/�+$/, "");
}

/**
 * The kind a process was named for by `processName`, read back from its
 * command line (`ps`'s `args`: the executable path, then its arguments), or
 * null for a process not named so. The name is the executable's file name, so
 * it starts the command line or follows its directory's `/`. A kind holds no
 * space (`build`, `server`, `agent`, `conv-…`), so it ends at the first space.
 */
export function processKindOf(args: string): string | null {
  const head = `${PRODUCT_NAME}${SEPARATOR}`;
  let at = args.startsWith(head) ? 0 : args.indexOf(`/${head}`) + 1;
  if (at === 0 && !args.startsWith(head)) return null;
  // The executable path ends at the first space after its name; a `/` before
  // the match inside an earlier argument is not the executable.
  if (args.slice(0, at).includes(" ")) return null;
  at += head.length;
  const end = args.indexOf(" ", at);
  const kind = end === -1 ? args.slice(at) : args.slice(at, end);
  return kind === "" ? null : kind;
}
