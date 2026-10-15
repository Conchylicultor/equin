import { join } from "path";
import { APP_STYLESHEET_PATH } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

/**
 * The one parser for app.css's `@utility` surface, shared by every generator
 * that derives a manifest from it (`custom-utilities-gen`, `space-ramp-gen`).
 *
 * app.css is the single source of truth for which custom utilities exist. Two
 * generators now read that fact, and a second hand-rolled scan would be a second
 * answer to "what does this stylesheet declare" — the drift class those
 * generators exist to close, reintroduced one layer up. So the scan lives here
 * once.
 *
 * Both helpers read the file by PATH via `fs`; the path is ui-kit's own
 * (`APP_STYLESHEET_PATH`, plain data in its `core`).
 */

/** Path to the app.css source every derived manifest reads. */
export function appCssPath(root: string): string {
  return join(root, APP_STYLESHEET_PATH);
}

/**
 * Replace every CSS block-comment's *body* with same-length spaces, leaving the
 * `/*` `*\/` delimiters and all non-comment text at their original byte offsets.
 * Used to locate REAL `@utility` declarations (an `@utility …` mention inside a
 * prose comment must not be mistaken for one) while preserving indices so the
 * original text can still be sliced for the markers (which ARE comments).
 */
export function maskCommentBodies(css: string): string {
  return css.replace(
    /\/\*[\s\S]*?\*\//g,
    (m) => "/*" + " ".repeat(m.length - 4) + "*/",
  );
}

/** One real `@utility` declaration: its class name and its byte offset. */
export interface UtilityDecl {
  name: string;
  start: number;
}

/**
 * Every real `@utility <name>` declaration in file order, located on the
 * comment-masked text so prose mentions are skipped. Offsets index the ORIGINAL
 * css, so a caller can slice between consecutive declarations to recover the
 * co-located markers.
 */
export function collectUtilityDecls(css: string): UtilityDecl[] {
  const masked = maskCommentBodies(css);
  const decls: UtilityDecl[] = [];
  for (const m of masked.matchAll(/@utility\s+([\w-]+)/g)) {
    decls.push({ name: m[1]!, start: m.index! });
  }
  return decls;
}
