import {
  findMarkerCalls,
  lineAt,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { DeclaredDeploySecret } from "../core";

/** The declaring call the facet reads (`deploy-secrets/core`'s factory). */
const MARKER = "defineDeploySecret";

/**
 * Every `defineDeploySecret({ key, description })` call in one source file.
 *
 * Read statically — the deploy side asks this of a composition's closure
 * without importing any of it — so both fields must be static string literals.
 * A call that is not (`defineDeploySecret(spec)`, a computed key) THROWS,
 * naming the file and line: a declaration the reader cannot see would be a
 * secret the deploy silently never asks the user about, and the box would run
 * without it.
 *
 * The factory's own definition (`function defineDeploySecret(spec: …)`) is not
 * a call and is skipped.
 */
export function extractDeploySecrets(
  src: string,
  file: string,
): DeclaredDeploySecret[] {
  const out: DeclaredDeploySecret[] = [];
  for (const call of findMarkerCalls(src, MARKER)) {
    if (/\bfunction\s+$/.test(src.slice(0, call.index))) continue;
    const where = `${file}:${lineAt(src, call.index)}`;
    const args = call.argsText.trim();
    if (!args.startsWith("{") || !args.endsWith("}")) {
      throw new Error(
        `[deploy-secrets facet] ${where}: ${MARKER}(…) must be called with an object ` +
          `literal ({ key: "…", description: "…" }) so the deploy side can read it statically.`,
      );
    }
    const body = args.slice(1, -1);
    const field = (name: "key" | "description"): string => {
      const r = parseStringField(body, name, { depth0: true });
      if (r.kind === "value") return r.value;
      throw new Error(
        `[deploy-secrets facet] ${where}: ${MARKER}'s \`${name}\` must be a static ` +
          `string literal (got ${r.kind === "dynamic" ? r.expr : "nothing"}).`,
      );
    };
    out.push({ key: field("key"), description: field("description"), file });
  }
  return out;
}
