import { describe, expect, it } from "bun:test";
import { symbolBody } from "@plugins/ui/plugins/icons/machine";
import type { SymbolName } from "@plugins/ui/plugins/icons/core";
import { ICON_MANIFEST } from "./icon-manifest.generated";
import { manifestSymbolBody } from "./sprites";

describe("manifestSymbolBody", () => {
  it("is the default style's drawing at rest, the one symbolBody reads from the sets", async () => {
    for (const name of ["home", ICON_MANIFEST.symbols[0]!] as SymbolName[]) {
      expect(await manifestSymbolBody(name)).toEqual(symbolBody(name));
    }
  });

  it("refuses a name the manifest does not hold", () => {
    expect(
      manifestSymbolBody("not-a-manifest-symbol" as SymbolName),
    ).rejects.toThrow(/not in the icon manifest/);
  });
});
