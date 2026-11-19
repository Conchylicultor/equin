import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import { stackCodeOrigin, type CodeOrigin } from "../../core";

/**
 * A window error's or unhandled rejection's crash fields, with whose code its
 * stack ran in (core/code-origin.ts) — judged against this document's own
 * inline scripts, read now, as the browser holds them.
 */
export function crashFieldsWithOrigin(
  err: Error,
): ReturnType<typeof crashFieldsOf> & { codeOrigin: CodeOrigin } {
  const fields = crashFieldsOf(err);
  const inlineScripts = Array.from(document.scripts)
    .filter((s) => !s.src)
    .map((s) => s.text);
  return {
    ...fields,
    codeOrigin: stackCodeOrigin(fields.stack, {
      documentUrl: window.location.href,
      inlineScripts,
    }),
  };
}
