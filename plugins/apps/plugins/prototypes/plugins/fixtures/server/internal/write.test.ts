/**
 * `writePrototypeFixture` against a real host: the fixture writer's server
 * closure booted on a browser host's providers (`test-host`'s
 * `withPortableHost`: PGlite with the real migrations, the in-process job
 * queue, the memory data-files store, snapshot history, no thumbnail
 * renderer — chosen, never listed), PAST its post-ready phases — so the files watcher, its history adoption and the
 * thumbnails sync are live, as they are when a demo's seed runs — then
 * written, and read back through the served resources and routes: each
 * history's steps, the picks, the tags and pin, and every version's
 * thumbnail.
 *
 * The fixture is this test's own (`testFixture`), with a tag per prototype
 * and a pin.
 *
 * Boots in a FRESH bun process (this file re-run as a child with
 * `PROTOTYPE_FIXTURE_BOOT_CHILD` set): a boot collects its own host-service
 * providers and registers its graph's resources process-wide, which would
 * leak into every suite after it in the shared `bun test` process.
 *
 * Run: `./equin test plugins/apps/plugins/prototypes/plugins/fixtures`.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import type {
  PrototypeHistory,
  StoredPicks,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { ThumbnailState } from "@plugins/apps/plugins/prototypes/plugins/thumbnails/core";
import { db } from "@plugins/database/server";
import {
  hostHttpRoutes,
  loadResourceByKey,
} from "@plugins/framework/plugins/server-core/core";
import {
  bootPluginGraph,
  runPostReadyPhases,
  serverEntryFor,
} from "@plugins/framework/plugins/server-core/core/testing";
import {
  registryClosureOf,
  withPortableHost,
} from "@plugins/framework/plugins/browser-server/plugins/test-host/server/testing";
import { createRequestHandler } from "@plugins/framework/plugins/http-router/core";
import { unmatchedApiResponse } from "@plugins/infra/plugins/endpoints/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { injectFrameAgent } from "@plugins/primitives/plugins/embed/plugins/frame/plugins/agent/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  parsePrototypeTree,
  prototypeFixtureVersionFingerprint,
  type PrototypeFixture,
  type PrototypeFixtureData,
  type ParsedPrototypeTree,
} from "../../core";
import { writePrototypeFixture } from "./write";

setDefaultTimeout(300_000);

const SUBJECT = "apps/plugins/prototypes/plugins/fixtures";

/** The writer's own entry: what its server barrel imports a server barrel of. */
const SUBJECT_ENTRY = serverEntryFor(SUBJECT, [
  "apps/plugins/prototypes",
  "apps/plugins/prototypes/plugins/files",
  "apps/plugins/prototypes/plugins/state",
  "apps/plugins/prototypes/plugins/thumbnails",
  "database",
]);

// What every serving host boots beside its features: the change feed that
// recomputes a DB-backed read after a write (`runPostReadyPhases` asserts it),
// and its companion pruner (`live-state-snapshot`'s `ChangelogRetention`),
// without which the feed's `onReady` refuses to start.
const HOST_PLUMBING = [
  "network/plugins/live/plugins/change-feed",
  "network/plugins/live/plugins/live-state-snapshot",
];

/**
 * This test's own small fixture: two prototypes, one with a two-step history
 * and a pick, laid out as a fixture tree (`steps/v<N>.txt` + `steps/v<N>/`,
 * `_picks/`). A browser host renders no thumbnail, so each version's PNG is a
 * stand-in keyed by the fingerprint the gallery computes — the writer and the
 * thumbnails route only store and serve the bytes.
 */
function testFixture(): PrototypeFixtureData {
  const tree: Record<string, string> = {
    "proto-1792900000-fixt01/index.html":
      '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Notes</h1></body></html>',
    "proto-1792900000-fixt01/styles.css": "h1 { color: black; }",
    "proto-1792900000-fixt01/steps/v1.txt":
      "Darker heading\n\nThe heading reads on any background.",
    "proto-1792900000-fixt01/steps/v1/styles.css": "h1 { color: #222; }",
    "proto-1792900000-fixt01/steps/v2.txt": "Accent heading",
    "proto-1792900000-fixt01/steps/v2/styles.css": "h1 { color: purple; }",
    "proto-1792900060-fixt02/index.html":
      "<!doctype html><html><body><p>Queue</p></body></html>",
    "_picks/proto-1792900000-fixt01.json": JSON.stringify({
      accent: "#14b8a6",
    }),
  };
  const thumbnails: Record<string, Uint8Array> = {};
  for (const p of parsePrototypeTree(tree).prototypes)
    for (const v of p.versions)
      thumbnails[prototypeFixtureVersionFingerprint(v)] =
        new TextEncoder().encode(`png ${p.id} v${v.n}`);
  return { tree, thumbnails };
}

const PINNED = "proto-1792900000-fixt01";
const TAGS: PrototypeFixture["tags"] = [
  {
    id: "prtag-1792900000-fixt01",
    name: "Notes",
    color: "purple",
    carriers: ["proto-1792900000-fixt01"],
  },
  {
    id: "prtag-1792900000-fixt02",
    name: "Agents",
    color: "blue",
    carriers: ["proto-1792900060-fixt02"],
  },
];

const IN_CHILD = process.env.PROTOTYPE_FIXTURE_BOOT_CHILD === "1";

if (!IN_CHILD) {
  test("a prototype fixture is written into a booted host (in a fresh process)", async () => {
    const result = await spawnCaptured(
      [process.execPath, "test", import.meta.path],
      {
        cwd: REPO_ROOT,
        // Its own graph: no desktop providers from the test preload.
        env: {
          ...process.env,
          PROTOTYPE_FIXTURE_BOOT_CHILD: "1",
          BOOTS_OWN_PLUGIN_GRAPH: "1",
        },
        timeoutMs: 240_000,
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `prototype fixture boot child exited ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);
    // The child ran the suite, not an empty file: every test of it passed.
    expect(result.stderr).toContain(" 6 pass");
  });
}

describe.if(IN_CHILD)("writePrototypeFixture, after the host is up", () => {
  let request: (req: Request) => Promise<Response>;
  let parsed: ParsedPrototypeTree;
  const fixture = IN_CHILD ? testFixture() : null;

  beforeAll(async () => {
    // `exec` mode: the app registry's edges are the desktop's, which reach a
    // few non-portable server barrels a worker's own graph does not.
    const ordered = await bootPluginGraph({
      mode: "exec",
      entries: await withPortableHost([
        ...registryClosureOf([...SUBJECT_ENTRY.dependsOn, ...HOST_PLUMBING]),
        SUBJECT_ENTRY,
      ]),
    });
    // Past ready, as a demo's seed runs: the watcher, the job queue, LISTEN.
    await runPostReadyPhases(ordered);
    request = createRequestHandler({
      routes: hostHttpRoutes(ordered),
      onError: (err, _req, pathname) => {
        console.error(
          `[fixture host] ${pathname}: ${err.stack ?? err.message}`,
        );
      },
      onUnmatched: unmatchedApiResponse,
    });
    parsed = await writePrototypeFixture({
      ...fixture!,
      tags: TAGS,
      pinned: [PINNED],
    });
  });

  const get = (path: string) =>
    request(new Request(`http://fixture.invalid${path}`));

  test("the gallery lists every prototype of the fixture", async () => {
    const list = (await loadResourceByKey("prototypes.list", {})) as {
      name: string;
    }[];
    expect(list.map((m) => m.name).sort()).toEqual(
      parsed.prototypes.map((p) => p.id),
    );
  });

  test("each history holds v0 then its steps, and every version's files are served", async () => {
    for (const p of parsed.prototypes) {
      const history = (await loadResourceByKey("prototypes.history", {
        name: p.id,
      })) as PrototypeHistory;
      expect(history.dirty).toBe(false);
      expect(history.versions).toHaveLength(p.versions.length);
      expect(history.versions.slice(1).map((v) => v.subject)).toEqual(
        p.versions.slice(1).map((v) => v.subject),
      );
      for (const [n, version] of history.versions.entries()) {
        const res = await get(
          `/api/prototypes/${p.id}/versions/${version.sha}/index.html`,
        );
        expect(res.status).toBe(200);
        // A content route's HTML carries the frame agent (content isolation):
        // the author's bytes, with the agent injected once at the head.
        expect(await res.text()).toBe(
          injectFrameAgent(p.versions[n]!.files["index.html"]!),
        );
      }
    }
    expect(await loadResourceByKey("prototypes.versionCounts", {})).toEqual(
      Object.fromEntries(
        parsed.prototypes.map((p) => [p.id, p.versions.length]),
      ),
    );
    // The fixture has history worth checking.
    expect(parsed.prototypes.some((p) => p.versions.length > 2)).toBe(true);
  });

  test("the picks records are the user's picks", async () => {
    const records = Object.entries(parsed.records);
    expect(records.length).toBeGreaterThan(0);
    for (const [path, text] of records) {
      const name = path.slice("_picks/".length, -".json".length);
      expect(
        (await loadResourceByKey("prototypes.picks", { name })) as StoredPicks,
      ).toEqual(JSON.parse(text) as StoredPicks);
    }
  });

  test("the tags in order, each prototype's tag and the pin", async () => {
    const tags = await db.execute<{
      id: string;
      name: string;
      color: string | null;
    }>(sql`SELECT id, name, color FROM prototype_tags ORDER BY rank`);
    expect(tags.rows).toEqual(
      TAGS!.map(({ id, name, color }) => ({ id, name, color })),
    );
    const states = await db.execute<{
      id: string;
      tag_id: string | null;
      pinned: boolean;
    }>(sql`SELECT id, tag_id, pinned FROM prototype_state ORDER BY id`);
    expect(states.rows).toEqual(
      TAGS!
        .flatMap((t) =>
          t.carriers.map((id) => ({ id, tag_id: t.id, pinned: id === PINNED })),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  test("every version's thumbnail is in the cache, and each card's is ready", async () => {
    for (const p of parsed.prototypes)
      for (const v of p.versions) {
        const key = prototypeFixtureVersionFingerprint(v);
        const png = await get(`/api/prototype-thumbs/${key}.png`);
        expect(png.status).toBe(200);
        expect(png.headers.get("content-type")).toContain("image/png");
        expect(new Uint8Array(await png.arrayBuffer())).toEqual(
          new Uint8Array(fixture!.thumbnails[key]!),
        );
      }
    // The thumbnails sync is the watcher's listener, fire-and-forget: wait
    // (bounded) for its answer — a cache hit, never `unavailable`.
    const want = Object.fromEntries(
      parsed.prototypes.map((p) => [
        p.id,
        prototypeFixtureVersionFingerprint(p.versions.at(-1)!),
      ]),
    );
    const deadline = Date.now() + 10_000;
    let states: Record<string, ThumbnailState> = {};
    const ready = ([id, key]: [string, string]): boolean =>
      JSON.stringify(states[id]) === JSON.stringify({ status: "ready", key });
    while (!Object.entries(want).every(ready)) {
      if (Date.now() > deadline)
        throw new Error(
          `timed out waiting for every card's thumbnail: ${JSON.stringify(states)}`,
        );
      await new Promise((r) => setTimeout(r, 20));
      states = (await loadResourceByKey("prototypes.thumbnails", {})) as Record<
        string,
        ThumbnailState
      >;
    }
    for (const [id, key] of Object.entries(want))
      expect(states[id]).toEqual({ status: "ready", key });
  });

  test("a fixture already in the tree is refused", async () => {
    const error = await writePrototypeFixture(fixture!).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(error)).toContain("already in the prototypes tree");
  });
});
