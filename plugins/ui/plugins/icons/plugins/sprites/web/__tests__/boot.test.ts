/**
 * The sprites boot task: it provides what the shell's head fetched at t0 — the
 * resident sprites and the saved-icon symbols — before the first render,
 * leaves a 409 (a head written by an earlier backend) to the host's live
 * reads, and throws on any other failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { pageRuntimeSymbols } from "@plugins/ui/plugins/icons/web";
import { headProvidedResident, runIconSpritesBoot } from "../internal/boot";
import { HEAD_REQUEST_GLOBAL } from "../../shared/head-request";

const svg = (id: string) => `<svg><symbol id="${id}"></symbol></svg>`;

function park(
  sprites: Record<string, Response>,
  saved: Response,
  hash = "h1",
): void {
  Reflect.set(globalThis, HEAD_REQUEST_GLOBAL, {
    startMs: 0,
    resident: {
      hash,
      sprites: Object.fromEntries(
        Object.entries(sprites).map(([k, r]) => [k, Promise.resolve(r)]),
      ),
    },
    saved: Promise.resolve(saved),
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

  it("provides the head's sprites and saved symbols, and takes them once", async () => {
    park(
      {
        "default-outline-400": new Response(svg("ms-default-outline-400-home")),
        brands: new Response("stale", { status: 409 }),
      },
      Response.json({
        names: ["rocket"],
        sprites: {
          "default-outline-400": svg("msr-default-outline-400-rocket"),
        },
      }),
    );
    await runIconSpritesBoot();
    const provided = headProvidedResident();
    expect(provided.hash).toBe("h1");
    // The 409 is left to the host's live read.
    expect([...provided.keys]).toEqual(["default-outline-400"]);
    expect(pageRuntimeSymbols.hasSymbol("default-outline-400", "rocket")).toBe(
      true,
    );
    expect(Reflect.get(globalThis, HEAD_REQUEST_GLOBAL)).toBeUndefined();
  });

  it("throws on a failure that is not a stale hash", async () => {
    park(
      { brands: new Response("boom", { status: 500 }) },
      new Response("stale", { status: 409 }),
    );
    await expect(runIconSpritesBoot()).rejects.toThrow(/failed \(500\)/);
  });
});
