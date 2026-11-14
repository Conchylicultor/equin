/**
 * The sprites boot task: it provides what the shell's head fetched at t0 — the
 * resident sprites and the glyph batches the page's last first frame drew —
 * before the first render, leaves a 409 (a hash the server moved past) to the
 * host's live reads, and throws on any other failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { pageRuntimeSymbols } from "@plugins/ui/plugins/icons/web";
import {
  headFirstFramePage,
  headProvidedGlyphs,
  headProvidedResident,
  runIconSpritesBoot,
} from "../internal/boot";
import { HEAD_REQUEST_GLOBAL } from "../../shared/head-request";

const svg = (id: string) => `<svg><symbol id="${id}"></symbol></svg>`;

function park(
  sprites: Record<string, Response>,
  glyphs: { hash: string; key: string; names: string; response: Response }[],
  hash = "h1",
  memoryError: string | null = null,
): void {
  Reflect.set(globalThis, HEAD_REQUEST_GLOBAL, {
    startMs: 0,
    resident: {
      hash,
      sprites: Object.fromEntries(
        Object.entries(sprites).map(([k, r]) => [k, Promise.resolve(r)]),
      ),
    },
    page: "agents",
    memoryError,
    glyphs: glyphs.map((g) => ({
      ...g,
      response: Promise.resolve(g.response),
    })),
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, HEAD_REQUEST_GLOBAL);
});

describe("runIconSpritesBoot", () => {
  it("does nothing without a head", async () => {
    await runIconSpritesBoot();
    expect(headProvidedResident().keys.size).toBe(0);
  });

  it("provides the head's sprites and remembered glyphs, and takes them once", async () => {
    park(
      {
        "default-outline-400": new Response(svg("ms-default-outline-400-home")),
        brands: new Response("stale", { status: 409 }),
      },
      [
        {
          hash: "m1",
          key: "default-outline-400",
          names: "rocket",
          response: new Response(svg("msr-default-outline-400-rocket")),
        },
        {
          hash: "old",
          key: "default-filled-400",
          names: "rocket",
          response: new Response("stale", { status: 409 }),
        },
      ],
    );
    await runIconSpritesBoot();
    const provided = headProvidedResident();
    expect(provided.hash).toBe("h1");
    // The 409s are left to the host's live reads.
    expect([...provided.keys]).toEqual(["default-outline-400"]);
    expect(pageRuntimeSymbols.hasSymbol("default-outline-400", "rocket")).toBe(
      true,
    );
    expect(headProvidedGlyphs()).toEqual([
      { hash: "m1", key: "default-outline-400", names: "rocket" },
    ]);
    expect(headFirstFramePage()).toBe("agents");
    expect(Reflect.get(globalThis, HEAD_REQUEST_GLOBAL)).toBeUndefined();
  });

  it("skips a remembered batch another build wrote (a 400), and reports a memory the head could not read", async () => {
    park(
      {},
      [
        {
          hash: "m1",
          key: "gone-key",
          names: "rocket",
          response: new Response("bad", { status: 400 }),
        },
      ],
      "h1",
      "SyntaxError: bad JSON",
    );
    await expect(runIconSpritesBoot()).rejects.toThrow(
      /could not read the page's first-frame memory: SyntaxError/,
    );
    expect(headProvidedGlyphs()).toEqual([]);
  });

  it("throws on a failure that is not a stale hash", async () => {
    park({ brands: new Response("boom", { status: 500 }) }, []);
    await expect(runIconSpritesBoot()).rejects.toThrow(/failed \(500\)/);
  });
});
