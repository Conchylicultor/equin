import { defaultExportObjectBody, parseBoolField } from "./helpers";

/**
 * Whether a server barrel's source claims `portable: true` — a top-level field
 * of its `export default { … }` object, read statically (never evaluated). The
 * one reading of the flag: `boundaries:portable-closure` measures the claim, and
 * the browser-host derivation (codegen) admits only barrels that make it.
 */
export function isPortableServerBarrel(source: string): boolean {
  const body = defaultExportObjectBody(source);
  return (
    body.kind === "object" &&
    parseBoolField(body.body, "portable", { depth0: true })
  );
}
