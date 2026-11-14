import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { recordBootSpan } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import {
  isGlyphKey,
  isSpriteKey,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import {
  pageRuntimeSymbols,
  provideSprite,
} from "@plugins/ui/plugins/icons/web";
import {
  HEAD_REQUEST_GLOBAL,
  type GlyphBatchAddress,
  type HeadSpriteRequests,
} from "../../shared/head-request";

/**
 * The resident sprites the head's requests provided, and the sprite hash they
 * were drawn under — read by the sprite host, which asks the server for every
 * resident key NOT provided under the hash it holds (no head, a head written
 * by an earlier backend, a failed request).
 */
let providedResident: { hash: string; keys: ReadonlySet<SpriteKey> } = {
  hash: "",
  keys: new Set(),
};

export function headProvidedResident(): {
  hash: string;
  keys: ReadonlySet<SpriteKey>;
} {
  return providedResident;
}

/**
 * The remembered first-frame glyph batches the head provided (its 409s — a
 * hash the server moved past — left out): the sprite host keeps them in the
 * page's memory beside the batches its first frame had to ask for.
 */
let providedGlyphs: readonly GlyphBatchAddress[] = [];

export function headProvidedGlyphs(): readonly GlyphBatchAddress[] {
  return providedGlyphs;
}

/** The page whose first-frame memory the head read — `null` with no head (nothing to remember for). */
let headPage: string | null = null;

export function headFirstFramePage(): string | null {
  return headPage;
}

/**
 * The head's requests (`server/internal/head.ts`), taken once. `absent` when
 * the shell was served without the head fragment (a backend that never
 * published its document head, a page that is not the gateway's shell, or a
 * second boot after Retry): the sprite host then reads every sprite live,
 * after the first paint.
 */
function takeHeadRequests():
  { kind: "taken"; requests: HeadSpriteRequests } | { kind: "absent" } {
  const value: unknown = Reflect.get(globalThis, HEAD_REQUEST_GLOBAL);
  if (value === undefined) return { kind: "absent" };
  Reflect.deleteProperty(globalThis, HEAD_REQUEST_GLOBAL);
  if (
    typeof value !== "object" ||
    value === null ||
    !("startMs" in value) ||
    typeof value.startMs !== "number" ||
    !("resident" in value) ||
    typeof value.resident !== "object" ||
    value.resident === null ||
    !("page" in value) ||
    typeof value.page !== "string" ||
    !("glyphs" in value) ||
    !Array.isArray(value.glyphs) ||
    !("memoryError" in value)
  ) {
    throw new Error(
      `icon sprites: globalThis.${HEAD_REQUEST_GLOBAL} is not the head script's requests`,
    );
  }
  return { kind: "taken", requests: value as HeadSpriteRequests };
}

/**
 * Read one head response. A 409 means the head named a hash this backend does
 * not serve (it was written by an earlier one): `stale`, and the host reads
 * the sprite live. Anything else that is not a 2xx is a failure, thrown.
 */
async function readHead(
  what: string,
  response: Promise<Response>,
  staleStatuses: readonly number[] = [409],
): Promise<{ kind: "stale" } | { kind: "ok"; body: string }> {
  const res = await response;
  if (staleStatuses.includes(res.status)) {
    await res.body?.cancel();
    return { kind: "stale" };
  }
  if (!res.ok) {
    throw new Error(
      `icon sprites: the head's request for ${what} failed (${res.status}): ${await res.text()}`,
    );
  }
  return { kind: "ok", body: await res.text() };
}

async function provideResident(
  requests: HeadSpriteRequests["resident"],
): Promise<void> {
  const keys = new Set<SpriteKey>();
  await Promise.all(
    Object.entries(requests.sprites).map(async ([key, response]) => {
      if (!isSpriteKey(key)) {
        throw new Error(
          `icon sprites: the head asked for an unknown sprite "${key}"`,
        );
      }
      const read = await readHead(`sprite "${key}"`, response);
      if (read.kind === "stale") return;
      provideSprite(key, read.body);
      keys.add(key);
    }),
  );
  providedResident = { hash: requests.hash, keys };
}

async function provideGlyphs(
  batches: HeadSpriteRequests["glyphs"],
): Promise<void> {
  // By index, so the memory keeps the head's order (oldest first).
  const provided: (GlyphBatchAddress | null)[] = batches.map(() => null);
  await Promise.all(
    batches.map(async ({ hash, key, names, response }, i) => {
      // A batch another build remembered (a key or address this server does
      // not answer: a 400) is stale like a moved hash (a 409): left to the
      // page's live reads, and out of the next memory.
      const read = await readHead(
        `glyphs ${key}/${names}`,
        response,
        [400, 409],
      );
      if (read.kind === "stale" || !isGlyphKey(key)) return;
      pageRuntimeSymbols.provide(
        `head-${i}`,
        read.body,
        names.split(",").map((name) => ({ key, name })),
      );
      provided[i] = { hash, key, names };
    }),
  );
  providedGlyphs = provided.filter((b) => b !== null);
}

/**
 * Provide what the head started fetching at t0 — the resident sprites and the
 * glyph batches the page's last first frame drew — before the first render,
 * so a first frame that draws what it drew last time wants nothing. Warm,
 * both come from the browser's HTTP cache (immutable addresses).
 */
export async function runIconSpritesBoot(): Promise<void> {
  const head = takeHeadRequests();
  if (head.kind === "absent") return;
  const { requests } = head;
  headPage = requests.page;
  await Promise.all([
    provideResident(requests.resident),
    provideGlyphs(requests.glyphs),
  ]);
  recordBootSpan({
    id: "icon-sprites",
    phase: "boot-tasks",
    label: "Icon sprites fetch",
    startMs: requests.startMs,
    durationMs: performance.now() - requests.startMs,
  });
  if (requests.memoryError !== null) {
    // The head fetched no remembered glyph: this load's first frame asks for
    // them live. Thrown after the providing, so the report costs nothing.
    throw new Error(
      `icon sprites: the head could not read the page's first-frame memory: ${requests.memoryError}`,
    );
  }
}

// `continue`: without them the page still paints, its icons arriving through
// the host's live reads a moment later; a failure is reported.
export const iconSpritesBootTask = Core.Boot({
  label: "Icon sprites",
  ifUnavailable: "continue",
  run: runIconSpritesBoot,
});
