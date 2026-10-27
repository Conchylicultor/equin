import { db } from "@plugins/database/server";
import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { PrototypeHistoryStore } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import { prototypeTagIdKind } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import {
  _prototypeState,
  _prototypeTags,
} from "@plugins/apps/plugins/prototypes/plugins/state/server";
import { thumbnailCache } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/server";
import { seedFiles } from "@plugins/infra/plugins/paths/plugins/data-files/plugins/memory/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  demoPrototypeSeed,
  demoVersionFingerprint,
  type DemoPrototypeData,
} from "../core";

/**
 * The demo's prototypes as the worker has them: `../data/` inlined into the
 * host bundle by the bundler that builds it (vite rewrites `import.meta.glob`
 * wherever it is written) — the seed tree as text, the thumbnails as base64
 * data URLs. Inside a function, not at module scope: Bun has no
 * `import.meta.glob`, and the boot test reads the same folder off disk instead
 * (`./browser-host.test.ts`). Empty is a bundler that stopped expanding
 * the globs, never a demo with no prototypes: loud.
 */
export function bundledDemoPrototypes(): DemoPrototypeData {
  const files = import.meta.glob<string>("../data/prototypes/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const pngs = import.meta.glob<string>("../data/thumbnails/*.png", {
    query: "?inline",
    import: "default",
    eager: true,
  });
  const tree: Record<string, string> = {};
  for (const [key, text] of Object.entries(files))
    tree[afterPrefix(key, "../data/prototypes/")] = text;
  const thumbnails: Record<string, Uint8Array> = {};
  for (const [key, url] of Object.entries(pngs)) {
    const name = afterPrefix(key, "../data/thumbnails/");
    thumbnails[name.slice(0, -".png".length)] = dataUrlBytes(key, url);
  }
  if (Object.keys(tree).length === 0 || Object.keys(thumbnails).length === 0)
    throw new Error(
      "[demo seed] the host bundle holds no demo prototypes or thumbnails — import.meta.glob was not expanded",
    );
  return { tree, thumbnails };
}

function afterPrefix(key: string, prefix: string): string {
  if (!key.startsWith(prefix))
    throw new Error(`[demo seed] unexpected bundle key "${key}"`);
  return key.slice(prefix.length);
}

const DATA_URL_RE = /^data:image\/png;base64,(.*)$/;

function dataUrlBytes(key: string, url: string): Uint8Array {
  const base64 = DATA_URL_RE.exec(url)?.[1];
  if (base64 === undefined)
    throw new Error(
      `[demo seed] ${key} was not inlined as a PNG data URL (got ${url.slice(0, 40)}…)`,
    );
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** The demo's prototype tags, and which prototype carries which (a prototype holds at most one). */
export const DEMO_PROTOTYPE_TAGS = [
  {
    id: "prtag-1792900000-demo01",
    name: "Lumen",
    color: "purple",
    carriers: ["proto-1792900000-demo01"],
  },
  {
    id: "prtag-1792900000-demo02",
    name: "Agent manager",
    color: "blue",
    carriers: ["proto-1792900060-demo02", "proto-1792900120-demo03"],
  },
] as const;

/** The prototype pinned to the top of the gallery. */
export const DEMO_PINNED_PROTOTYPE = "proto-1792900000-demo01";

/**
 * The demo's prototypes into a fresh host, in the order a real tree grew:
 *
 * 1. each folder as it first was (`v0`) — into the `prototypesFiles` root, the
 *    memory store's in this host;
 * 2. its history: adopted (`v0`), then each step's files laid over it and
 *    recorded as a version through the host's own `PrototypeHistoryStore`;
 * 3. the record files — the user's option picks (`_picks/<id>.json`);
 * 4. the gallery's rows: the tags, each prototype's tag, the pin;
 * 5. the thumbnails, rendered ahead of time by the real renderer
 *    (`./equin prototype thumbnails`, through `../scripts/render-demo-thumbnails.ts`)
 *    and committed by fingerprint — written into the cache root, they answer
 *    as any cache hit, so every seeded version (and a restore of one) shows
 *    its picture. A version with no PNG is loud here too, as the build's
 *    `demo:prototype-thumbnails-in-sync` check is.
 *
 * Before `onReady`: the files watcher, the history adoption and the
 * thumbnails sync start only after the seed, and find it all in place.
 */
export async function seedPrototypes(data: DemoPrototypeData): Promise<void> {
  const { prototypes, records } = demoPrototypeSeed(data.tree);
  const missing = prototypes.flatMap((p) =>
    p.versions.flatMap((v) => {
      const key = demoVersionFingerprint(v);
      return data.thumbnails[key] === undefined ? [`${p.id} v${v.n}`] : [];
    }),
  );
  if (missing.length > 0)
    throw new Error(
      `[demo seed] no committed thumbnail for ${missing.join(", ")} — run \`./equin run plugins/apps/plugins/agent-manager/plugins/demo/scripts/render-demo-thumbnails.ts\``,
    );

  for (const p of prototypes)
    await seedFiles(prototypesFiles, inFolder(p.id, p.versions[0]!.files));
  const history = PrototypeHistoryStore.get();
  for (const p of prototypes) {
    const adopted = await history.ensureHistory(p.id);
    if (adopted.kind !== "created")
      throw new Error(`[demo seed] ${p.id}'s history: ${adopted.kind}`);
    for (const version of p.versions.slice(1)) {
      await seedFiles(prototypesFiles, inFolder(p.id, version.changed));
      const recorded = await history.checkpoint(p.id, {
        kind: "turn",
        subject: version.subject,
        ...(version.body === "" ? {} : { body: version.body }),
      });
      if (recorded.kind !== "recorded")
        throw new Error(
          `[demo seed] ${p.id} v${version.n} was not recorded: ${recorded.kind}`,
        );
    }
  }
  await seedFiles(prototypesFiles, records);

  const ranks = Rank.nBetween(null, null, DEMO_PROTOTYPE_TAGS.length);
  for (const [i, tag] of DEMO_PROTOTYPE_TAGS.entries()) {
    await db.insert(_prototypeTags).values({
      id: prototypeTagIdKind.parse(tag.id),
      name: tag.name,
      parentId: null,
      color: tag.color,
      childColors: null,
      icon: null,
      rank: ranks[i]!.toJSON(),
    });
    for (const id of tag.carriers)
      await db.insert(_prototypeState).values({
        id: protoIdKind.parse(id),
        tagId: prototypeTagIdKind.parse(tag.id),
        pinned: id === DEMO_PINNED_PROTOTYPE,
      });
  }

  await seedFiles(
    thumbnailCache,
    Object.fromEntries(
      Object.entries(data.thumbnails).map(([key, png]) => [`${key}.png`, png]),
    ),
  );
}

/** A version's folder name → text, as paths inside the prototypes root. */
function inFolder(
  id: string,
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([name, text]) => [`${id}/${name}`, text]),
  );
}
