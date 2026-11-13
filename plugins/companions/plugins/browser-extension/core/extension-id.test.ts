import { describe, expect, test } from "bun:test";
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  extensionIdFromKey,
} from "./extension-id";

describe("extensionIdFromKey", () => {
  // The expected id was computed apart from this code (Python's hashlib over
  // the key's DER bytes, mapped 0-f → a-p) — and is the id Chrome shows for
  // the shell built with this key.
  test("derives the id Chrome derives", () => {
    expect(
      extensionIdFromKey(
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtJ6ftn1KMCYfa8GpXoftYlBQ3zFrygxFhbqg5W3I18N2bs2ohZ2sCAzK0VrFcgqH9QkRiFGJzRecVCuK2100Z4GcWevWNodA/WB3wnUY41ftfpNCFS2fEzAmZ0zlUBTQ8gYpmID1yl6hIZZvzKHY3AWnsle2WcMdgJUY76lyUgGktZA1XC51mcbgvjlNwoIHbeSuzhW8I64EboCptAfb/nidzsZ5Wt12q9BHqkiJSx61oxw2Z/dTP3bdmasJekNgJh1uEO722Zrc/oRhn08khXST+rpN8AE8082LDOcPyl1ix3ZsvX9h1AesgPJJp17UzmsS4QxDaMPpAeg4YU95+wIDAQAB",
      ),
    ).toBe("mdeplghmbfadlplpgfdedbogaancamhf");
  });

  test("the extension's id is 32 letters a–p, and its origin names it", () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EXTENSION_ID}`);
  });
});
