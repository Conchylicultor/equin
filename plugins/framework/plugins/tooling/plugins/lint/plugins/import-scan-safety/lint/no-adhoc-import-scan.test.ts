import { describe, expect, it } from "bun:test";
import { isImportScanSource } from "./no-adhoc-import-scan";

describe("isImportScanSource", () => {
  it("flags static and dynamic import scanners", () => {
    expect(
      isImportScanSource(
        /\b(import|export)\b([^"'`;]*?)\bfrom\s*(["'`])/.source,
      ),
    ).toBe(true);
    expect(isImportScanSource(/\bimport\s*\(\s*(["'`])/.source)).toBe(true);
    expect(isImportScanSource(/import\(\s*["']/.source)).toBe(true);
  });

  it("leaves other regexes alone", () => {
    expect(isImportScanSource(/\bselect\b.*\bfrom\s*"/.source)).toBe(false);
    expect(isImportScanSource(/\bimport\s*\(/.source)).toBe(false);
    expect(isImportScanSource(/foo\(\s*"/.source)).toBe(false);
  });
});
