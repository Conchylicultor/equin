import { describe, expect, it } from "bun:test";
import { handleRuntimeSymbols } from "./handle-runtime-symbols";
import { symbolsHash } from "./runtime-symbols";

function get(hash: string, key: string, names: string | null) {
  const qs = names === null ? "" : `?names=${encodeURIComponent(names)}`;
  return handleRuntimeSymbols(
    new Request(`http://x/api/icons/symbols/${hash}/${key}${qs}`),
    { hash, key },
  );
}

describe("GET /api/icons/symbols/:hash/:key", () => {
  it("refuses a hash that is not this server's (409)", async () => {
    expect((await get("stale", "default-outline-400", "home")).status).toBe(
      409,
    );
  });

  it("404s an unknown style key or name", async () => {
    expect((await get(symbolsHash, "nope", "home")).status).toBe(404);
    expect(
      (await get(symbolsHash, "default-outline-400", "home,not_a_symbol"))
        .status,
    ).toBe(404);
  });

  it("400s names that are missing, unsorted or duplicated", async () => {
    expect((await get(symbolsHash, "default-outline-400", null)).status).toBe(
      400,
    );
    expect(
      (await get(symbolsHash, "default-outline-400", "rocket,home")).status,
    ).toBe(400);
    expect(
      (await get(symbolsHash, "default-outline-400", "home,home")).status,
    ).toBe(400);
  });

  it("serves one runtime <symbol> per name in the style, immutable", async () => {
    const res = await get(symbolsHash, "rounded-filled-300", "home,smart-toy");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    const svg = await res.text();
    expect(svg).toContain('id="msr-rounded-filled-300-home"');
    expect(svg).toContain('id="msr-rounded-filled-300-smart-toy"');
  });
});
