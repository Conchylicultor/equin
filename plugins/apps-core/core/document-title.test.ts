import { describe, expect, test } from "bun:test";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { documentTitle } from "./document-title";

describe("documentTitle", () => {
  test("entity, app, product — each once", () => {
    expect(documentTitle({ entity: "Inbox", app: "Mail" })).toBe(
      `Inbox — Mail — ${PRODUCT_NAME}`,
    );
  });
  test("an app named after the product says it once", () => {
    expect(documentTitle({ entity: "Download", app: PRODUCT_NAME })).toBe(
      `Download — ${PRODUCT_NAME}`,
    );
  });
  test("unknown parts are left out", () => {
    expect(documentTitle({ entity: undefined, app: undefined })).toBe(
      PRODUCT_NAME,
    );
    expect(documentTitle({ entity: "", app: "Mail" })).toBe(
      `Mail — ${PRODUCT_NAME}`,
    );
  });
});
