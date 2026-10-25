import { describe, expect, it } from "bun:test";
import { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import { MAX_RUNTIME_SYMBOLS_PER_READ } from "../../core";
import { symbolsHash } from "./runtime-symbols";
import { loadRuntimeSymbols } from "./runtime-symbols-value";

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ResourceRefusal) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

const K = "default-outline-400";

describe("icons.runtime-symbols", () => {
  it("refuses a hash that is not this server's", async () => {
    expect(
      await refusal(
        loadRuntimeSymbols({ hash: "stale", key: K, names: "home" }),
      ),
    ).toBe("stale-symbols");
  });

  it("refuses an unknown style key or name", async () => {
    expect(
      await refusal(
        loadRuntimeSymbols({ hash: symbolsHash, key: "nope", names: "home" }),
      ),
    ).toBe("unknown-key");
    expect(
      await refusal(
        loadRuntimeSymbols({
          hash: symbolsHash,
          key: K,
          names: "home,not_a_symbol",
        }),
      ),
    ).toBe("unknown-name");
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
        await refusal(loadRuntimeSymbols({ hash: symbolsHash, key: K, names })),
      ).toBe("invalid-names");
    }
  });

  it("serves one runtime <symbol> per name in the style", async () => {
    const svg = await loadRuntimeSymbols({
      hash: symbolsHash,
      key: "rounded-filled-300",
      names: "home,smart-toy",
    });
    expect(svg).toContain('id="msr-rounded-filled-300-home"');
    expect(svg).toContain('id="msr-rounded-filled-300-smart-toy"');
  });
});
