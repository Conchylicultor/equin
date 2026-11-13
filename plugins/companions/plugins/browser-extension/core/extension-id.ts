import { createSha256 } from "@plugins/packages/plugins/string-hash/core";

/**
 * The extension's public key: the base64 DER SubjectPublicKeyInfo of an RSA
 * key generated once (its private half was never kept — an unpacked extension
 * needs none). The build writes it into the shell's `manifest.json` as `key`,
 * and Chrome derives the extension's id from it, so the id is the same on
 * every machine and across every reload — the one fact the page's origin
 * check rests on.
 *
 * Never change it: a new key is a new extension id, and every installed copy
 * would stop being trusted by the page.
 */
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtJ6ftn1KMCYfa8GpXoftYlBQ3zFrygxFhbqg5W3I18N2bs2ohZ2sCAzK0VrFcgqH9QkRiFGJzRecVCuK2100Z4GcWevWNodA/WB3wnUY41ftfpNCFS2fEzAmZ0zlUBTQ8gYpmID1yl6hIZZvzKHY3AWnsle2WcMdgJUY76lyUgGktZA1XC51mcbgvjlNwoIHbeSuzhW8I64EboCptAfb/nidzsZ5Wt12q9BHqkiJSx61oxw2Z/dTP3bdmasJekNgJh1uEO722Zrc/oRhn08khXST+rpN8AE8082LDOcPyl1ix3ZsvX9h1AesgPJJp17UzmsS4QxDaMPpAeg4YU95+wIDAQAB";

/**
 * Chrome's extension id for a manifest `key`: the first 32 hex digits of the
 * SHA-256 of the key's DER bytes, each digit 0–f spelled as a letter a–p.
 */
export function extensionIdFromKey(base64Key: string): string {
  const der = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return createSha256()
    .update(der)
    .hex()
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (d) =>
      String.fromCharCode("a".charCodeAt(0) + parseInt(d, 16)),
    );
}

/** The extension's id, derived from its key so the two cannot drift. */
export const EXTENSION_ID = extensionIdFromKey(EXTENSION_PUBLIC_KEY);

/** The origin of the extension's own pages (its popup). */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
