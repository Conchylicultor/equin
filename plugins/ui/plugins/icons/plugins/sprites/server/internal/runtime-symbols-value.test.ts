import { describe, expect, it } from "bun:test";
import { MAX_RUNTIME_SYMBOLS_PER_READ } from "../../core";
import { symbolsHash } from "./drawer";
import { loadRuntimeSymbols } from "./runtime-symbols-value";

const K = "default-outline-400";

describe("icons.runtime-symbols", () => {
  it("refuses a hash that is not this server's", async () => {
    expect(
      loadRuntimeSymbols({ hash: "stale", key: K, names: "home" }),
    ).rejects.toMatchObject({ code: "stale-symbols" });
  });

  it("refuses an unknown glyph key", async () => {
    expect(
      loadRuntimeSymbols({ hash: symbolsHash(), key: "nope", names: "home" }),
    ).rejects.toMatchObject({ code: "unknown-key" });
  });

  it("answers a name it draws no glyph for without its symbol (the page marks it missing)", async () => {
    const svg = await loadRuntimeSymbols({
      hash: symbolsHash(),
      key: K,
      names: "home,not_a_symbol",
    });
    expect(svg).toContain('id="msr-default-outline-400-home"');
    expect(svg).not.toContain("not_a_symbol");
  });

  it("refuses names that are empty, unsorted, duplicated or over the cap", async () => {
    for (const names of [
      "",
      "rocket,home",
      "home,home",
      Array.from(
        { length: MAX_RUNTIME_SYMBOLS_PER_READ + 1 },
        (_, i) => `n${String(i).padStart(4, "0")}`,
      ).join(","),
    ]) {
      expect(
        loadRuntimeSymbols({ hash: symbolsHash(), key: K, names }),
      ).rejects.toMatchObject({ code: "invalid-names" });
    }
  });

  it("serves one runtime <symbol> per name in the style", async () => {
    const svg = await loadRuntimeSymbols({
      hash: symbolsHash(),
      key: "rounded-filled-300",
      names: "home,smart-toy",
    });
    expect(svg).toContain('id="msr-rounded-filled-300-home"');
    expect(svg).toContain('id="msr-rounded-filled-300-smart-toy"');
  });
});
