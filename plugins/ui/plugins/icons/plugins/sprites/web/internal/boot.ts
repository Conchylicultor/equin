import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { recordBootSpan } from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";
import {
  isSpriteKey,
  isStyleKey,
  type SpriteKey,
} from "@plugins/ui/plugins/icons/core";
import {
  pageRuntimeSymbols,
  provideSprite,
} from "@plugins/ui/plugins/icons/web";
import { SavedSpriteAssetSchema } from "../../core";
import {
  HEAD_REQUEST_GLOBAL,
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
    !("saved" in value) ||
    !(value.saved instanceof Promise)
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
): Promise<{ kind: "stale" } | { kind: "ok"; body: string }> {
  const res = await response;
  if (res.status === 409) {
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

async function provideSaved(response: Promise<Response>): Promise<void> {
  const read = await readHead("the saved-icon sprites", response);
  if (read.kind === "stale") return;
  const asset = SavedSpriteAssetSchema.parse(JSON.parse(read.body));
  for (const [key, markup] of Object.entries(asset.sprites)) {
    if (!isStyleKey(key)) {
      throw new Error(
        `icon sprites: the saved-icon sprites hold no "${key}" style`,
      );
    }
    pageRuntimeSymbols.provide(
      `saved-${key}`,
      markup,
      asset.names.map((name) => ({ styleKey: key, name })),
    );
  }
}

/**
 * Provide the sprites the head started fetching at t0 — the resident ones and
 * the saved-icon symbols — before the first render, so no icon on the first
 * frame waits for one. Warm, both come from the browser's HTTP cache (the
 * resident ones are immutable, the saved ones a 304).
 */
export async function runIconSpritesBoot(): Promise<void> {
  const head = takeHeadRequests();
  if (head.kind === "absent") return;
  const { requests } = head;
  await Promise.all([
    provideResident(requests.resident),
    provideSaved(requests.saved),
  ]);
  recordBootSpan({
    id: "icon-sprites",
    phase: "boot-tasks",
    label: "Icon sprites fetch",
    startMs: requests.startMs,
    durationMs: performance.now() - requests.startMs,
  });
}

// `continue`: without them the page still paints, its icons arriving through
// the host's live reads a moment later; a failure is reported.
export const iconSpritesBootTask = Core.Boot({
  label: "Icon sprites",
  ifUnavailable: "continue",
  run: runIconSpritesBoot,
});
