/**
 * The browser-host coverage guard over fixtures: a live read, an endpoint or a
 * raw `/api` URL the scoped page references is covered when a graph member's
 * `server/` serves it or it declares `needsMachine`; otherwise the guard
 * throws, naming the key, the reader (file:line), the serving plugin and why
 * it is outside the graph. References are followed through barrels and into
 * the core helpers a reader imports; a page-bound file's (it imports
 * `pageTransport`) endpoints are the page's, its live reads still the
 * scope's, and it may hold no scope fetcher. The config arm pairs a scoped web
 * registration with a member's `server/` registration; the contributions arm
 * refuses a scoped plugin's out-of-graph contribution to a kind a member
 * declares, unless the kind is `absentOnHost`.
 */

import { describe, expect, test } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  createSourceScans,
  resolveHostConfigCoverage,
  resolveHostContributionCoverage,
  resolveHostCoverage,
  type HostConfigRegistration,
  type HostCoverageInputs,
  type SourceScans,
} from "./browser-host-coverage";

// Fixture paths go through `pj(rel)` rather than bare `plugins/<seg>/…`
// literals — the repo's own `plugin-refs-resolve` check validates that every
// such literal in source resolves to a real plugin, and these are synthetic.
const pj = (rel: string): string => `plugins/${rel}`;

/** A fixture repo over `files` (repo-relative path → source). */
function repoOf(files: Record<string, string>): SourceScans["repo"] {
  const paths = Object.keys(files).sort();
  return {
    has: (p) => p in files,
    under: (dir) => paths.filter((p) => p.startsWith(`${dir}/`)),
    read: async (p) => files[p] ?? null,
  };
}

function inputs(
  files: Record<string, string>,
  over: Partial<HostCoverageInputs> = {},
): HostCoverageInputs {
  return {
    label: "fixture",
    members: ["app"],
    webPlugins: [asPluginId("app")],
    bundle: new Set(["app", "disk"]),
    sources: createSourceScans(repoOf(files)),
    blockers: async () => ["disk/server is not portable (via a → b)"],
    ...over,
  };
}

/** The rejection's message (bun's `rejects` is typed `void`). */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection");
}

const VALUE = `import { liveValue } from "@plugins/network/plugins/live/core";
export const greeting = liveValue("app.greeting", { schema: S });
export const remote = liveValue("app.remote", { schema: S, needsMachine: { feature: "x" } });
`;
const BARREL = `export { greeting, remote } from "./values";
export { ping, launch } from "./endpoints";
`;
const ENDPOINTS = `import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
export const ping = defineEndpoint({ route: "POST /api/app/ping", body: B });
export const launch = defineEndpoint({ route: "POST /api/app/launch", needsMachine: M });
`;
const SERVED = `import { serveValue } from "@plugins/network/plugins/live/server";
import { greeting } from "../../core";
export const greetingServed = serveValue(greeting, { source: "external", changes: "notified", loader: () => "hi" });
`;
const SERVER_BARREL = `import { ping } from "../core";
import { handlePing } from "./internal/ping";
export default { portable: true, httpRoutes: { [ping.route]: handlePing } };
`;

const BASE: Record<string, string> = {
  [pj("app/core/index.ts")]: BARREL,
  [pj("app/core/values.ts")]: VALUE,
  [pj("app/core/endpoints.ts")]: ENDPOINTS,
  [pj("app/server/index.ts")]: SERVER_BARREL,
  [pj("app/server/internal/served.ts")]: SERVED,
};

describe("resolveHostCoverage", () => {
  test("a served read, a needsMachine read and a served endpoint are covered; the reads are listed", async () => {
    const { reads } = await resolveHostCoverage(
      inputs({
        ...BASE,
        [pj("app/web/view.tsx")]:
          `import { greeting, remote, ping, launch } from "@plugins/app/core";\nuse(greeting, remote, ping, launch);`,
      }),
    );
    expect(reads).toEqual([
      { key: "app.greeting", needsMachine: false },
      { key: "app.remote", needsMachine: true },
    ]);
  });

  test("an unserved read throws, naming its reader and why its server is outside the graph", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("disk/core/index.ts")]:
            `import { liveValue } from "@plugins/network/plugins/live/core";\nexport const files = liveValue("disk.files", { schema: S });`,
          [pj("disk/server/index.ts")]:
            `import { files } from "../core";\nimport { serveValue } from "@plugins/network/plugins/live/server";\nexport const served = serveValue(files, { source: "external", changes: "notified", loader: () => 1 });\nexport default {};`,
          [pj("app/web/view.tsx")]:
            `import { files } from "@plugins/disk/core";\n\nuse(files);`,
        }),
      ),
    );
    expect(message).toContain(
      'live read "disk.files" (plugins/disk/core/index.ts) is not served by the graph: served by disk/server, which is not portable: disk/server is not portable (via a → b)',
    );
    expect(message).toContain("read at plugins/app/web/view.tsx:1");
  });

  test("a read served only from machine/ must declare needsMachine", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("app/core/extra.ts")]:
            `import { liveValue } from "@plugins/network/plugins/live/core";\nexport const disk = liveValue("app.disk", { schema: S });`,
          [pj("app/machine/index.ts")]:
            `import { serveValue } from "@plugins/network/plugins/live/machine";\nimport { disk } from "../core/extra";\nexport const s = serveValue(disk, { source: "external", changes: "notified", loader: () => 1 });\nexport default {};`,
          [pj("app/web/view.tsx")]:
            `import { disk } from "../core/extra";\nuse(disk);`,
        }),
      ),
    );
    expect(message).toContain(
      'live read "app.disk" (plugins/app/core/extra.ts) is not served by the graph: served by app/machine — desktop-only',
    );
  });

  test("a central read must declare needsMachine, served or not", async () => {
    const central = `import { liveValue } from "@plugins/network/plugins/live/core";\nexport const runs = liveValue("app.central-runs", { schema: S, origin: "central" });\nexport const machineRuns = liveValue("app.central-machine", { schema: S, origin: "central", needsMachine: M });`;
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("app/core/central.ts")]: central,
          [pj("app/web/view.tsx")]:
            `import { runs } from "../core/central";\nuse(runs);`,
        }),
      ),
    );
    expect(message).toContain(
      'live read "app.central-runs" (plugins/app/core/central.ts) is central\'s (origin: "central") and not `needsMachine`',
    );
    const { reads } = await resolveHostCoverage(
      inputs({
        ...BASE,
        [pj("app/core/central.ts")]: central,
        [pj("app/web/view.tsx")]:
          `import { machineRuns } from "../core/central";\nuse(machineRuns);`,
      }),
    );
    expect(reads).toEqual([{ key: "app.central-machine", needsMachine: true }]);
  });

  test("an unserved endpoint a core helper calls is found through the helper", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("app/core/helper.ts")]:
            `import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";\nexport const save = defineEndpoint({ route: "POST /api/app/save" });\nexport function saveIt() { return save; }`,
          [pj("app/web/view.tsx")]:
            `import { saveIt } from "../core/helper";\nsaveIt();`,
        }),
      ),
    );
    expect(message).toContain(
      'endpoint "POST /api/app/save" (save, plugins/app/core/helper.ts) is not served by the graph: nothing in the repo serves it',
    );
    expect(message).toContain("called at plugins/app/core/helper.ts:3");
  });

  const PAGE_TRANSPORT_IMPORT = `import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";`;
  const DISK_ENDPOINT = {
    [pj("disk/core/index.ts")]:
      `import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";\nimport { liveValue } from "@plugins/network/plugins/live/core";\nexport const beacon = defineEndpoint({ route: "POST /api/disk/beacon" });\nexport const files = liveValue("disk.files", { schema: S });`,
  };

  test("a page-bound file's endpoints are the page's", async () => {
    await resolveHostCoverage(
      inputs({
        ...BASE,
        ...DISK_ENDPOINT,
        [pj("app/web/telemetry.ts")]:
          `${PAGE_TRANSPORT_IMPORT}\nimport { beacon } from "@plugins/disk/core";\nconst fetchEndpoint = fetchEndpointOver(pageTransport);\nvoid fetchEndpoint(beacon, {});`,
      }),
    );
  });

  test("a page-bound file's live reads are still the scope's", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          ...DISK_ENDPOINT,
          [pj("app/web/telemetry.ts")]:
            `${PAGE_TRANSPORT_IMPORT}\nimport { files } from "@plugins/disk/core";\nuse(useLive(files), pageTransport);`,
        }),
      ),
    );
    expect(message).toContain('live read "disk.files"');
  });

  test("a page-bound file holding a scope fetcher too is refused", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("app/web/telemetry.ts")]:
            `${PAGE_TRANSPORT_IMPORT}\nexport async function act(fetchEndpoint: FetchEndpoint) { use(pageTransport); }`,
        }),
      ),
    );
    expect(message).toContain(
      "imports `pageTransport` and holds a scope fetcher too",
    );
  });

  test("a raw /api URL to a prefix no member serves throws — whether a non-member serves it or none does", async () => {
    const files = {
      ...BASE,
      [pj("disk/core/index.ts")]:
        `import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";\nexport const raw = defineEndpoint({ route: "GET /api/disk/raw" });`,
      [pj("disk/server/index.ts")]:
        `import { raw } from "../core";\nexport default { httpRoutes: { [raw.route]: h } };`,
    };
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...files,
          [pj("app/web/view.tsx")]: 'fetch("/api/disk/raw?path=x");',
        }),
      ),
    );
    expect(message).toContain(
      'a raw "/api/disk" URL is not served by the graph',
    );
    const unrouted = await rejection(
      resolveHostCoverage(
        inputs({
          ...files,
          [pj("app/web/view.tsx")]: 'fetch("/api/mirror/" + id);',
        }),
      ),
    );
    expect(unrouted).toContain(
      'a raw "/api/mirror" URL is not served by the graph (a URL built by hand cannot declare `needsMachine`',
    );
    expect(unrouted).toContain("nothing in the repo serves it");
  });

  test("a raw URL to a member's prefix is covered; prose naming a route is no URL", async () => {
    await resolveHostCoverage(
      inputs({
        ...BASE,
        [pj("app/web/view.tsx")]:
          'fetch("/api/app/other"); // "GET /api/disk/raw" in prose is no URL',
      }),
    );
  });

  test("an httpRoutes key the scan cannot read throws, naming the barrel and the key", async () => {
    for (const [key, why] of [
      ["[ROUTE_KEY]", "is not readable"],
      [`[\`GET \${BASE}/:id\`]`, "is not readable"],
      [`\`GET \${BASE}/:id\``, "is a template with a substitution"],
      ["[other.path]", "is not readable"],
      ["[missing.route]", "names no endpoint declaration"],
    ] as const) {
      const message = await rejection(
        resolveHostCoverage(
          inputs({
            ...BASE,
            [pj("app/server/index.ts")]:
              `import { ping } from "../core";\nexport default { portable: true, httpRoutes: { [ping.route]: h, ${key}: h } };`,
            [pj("app/web/view.tsx")]:
              `import { ping } from "@plugins/app/core";\nuse(ping);`,
          }),
        ),
      );
      expect(message).toContain(
        `plugins/app/server/index.ts: \`httpRoutes\` key \`${key}\` ${why}`,
      );
    }
    for (const entry of ["...more", "shorthand"]) {
      const message = await rejection(
        resolveHostCoverage(
          inputs({
            ...BASE,
            [pj("app/server/index.ts")]:
              `import { ping } from "../core";\nexport default { portable: true, httpRoutes: { [ping.route]: h, ${entry} } };`,
          }),
        ),
      );
      expect(message).toContain("is not a `key: handler` pair");
    }
    const notObject = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("app/server/index.ts")]:
            "const routes = {};\nexport default { portable: true, httpRoutes: routes };",
        }),
      ),
    );
    expect(notObject).toContain("`httpRoutes` is not one object literal");
  });

  test("a bad httpRoutes key in a NON-member barrel throws too (every backend barrel is read)", async () => {
    const message = await rejection(
      resolveHostCoverage(
        inputs({
          ...BASE,
          [pj("disk/machine/index.ts")]:
            "export default { httpRoutes: { [ROUTE_KEY]: h } };",
        }),
      ),
    );
    expect(message).toContain(
      "plugins/disk/machine/index.ts: `httpRoutes` key `[ROUTE_KEY]` is not readable",
    );
  });

  test("a handler's type arguments and an arrow in it split no entry", async () => {
    const { reads } = await resolveHostCoverage(
      inputs({
        ...BASE,
        [pj("app/server/index.ts")]:
          `import { ping } from "../core";\nexport default { portable: true, httpRoutes: { [ping.route]: wrap<Req, Res>((r) => r.n >= 1 ? a : b), "GET /api/app/x": wrap<Map<string, number>>(h) } };`,
        [pj("app/web/view.tsx")]:
          `import { ping } from "@plugins/app/core";\nuse(ping);\nfetch("/api/app/x");`,
      }),
    );
    expect(reads).toEqual([]);
  });

  test("a literal route key and a [decl.route] key are both read", async () => {
    await resolveHostCoverage(
      inputs({
        ...BASE,
        [pj("app/core/extra.ts")]:
          `import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";\nexport const lit = defineEndpoint({ route: "GET /api/lit/x" });`,
        [pj("app/server/index.ts")]:
          `import { ping } from "../core";\nexport default { portable: true, httpRoutes: { [ping.route]: h, "GET /api/lit/x": h, 'GET /api/lit/y': h } };`,
        [pj("app/web/view.tsx")]:
          `import { lit } from "../core/extra";\nuse(lit);\nfetch("/api/lit/y");`,
      }),
    );
  });
});

describe("resolveHostConfigCoverage", () => {
  const reg = (
    runtime: HostConfigRegistration["runtime"],
    registrar: string,
    folder = runtime,
  ): HostConfigRegistration => ({
    runtime,
    registrar,
    owner: registrar,
    storePath: `${registrar}/config.jsonc`,
    barrel: `plugins/${registrar}/${folder}/index.ts`,
  });
  const config = (registrations: HostConfigRegistration[]) =>
    resolveHostConfigCoverage({
      label: "fixture",
      members: ["app"],
      webPlugins: [asPluginId("app"), asPluginId("disk")],
      bundle: new Set(["app", "disk"]),
      registrations,
      blockers: async () => ["it reads the disk"],
    });

  test("a scoped web registration a member's server/ registers is covered", async () => {
    expect(await config([reg("web", "app"), reg("server", "app")])).toEqual([]);
  });

  test("one registered in machine/ or by a non-member is not, and says why", async () => {
    const problems = await config([
      reg("web", "app"),
      reg("machine", "app"),
      reg("web", "disk"),
      reg("server", "disk"),
    ]);
    expect(problems).toEqual([
      'fixture: config "app/config.jsonc" registered on web by plugins/app/web/index.ts is not served by the graph: served by app/machine — desktop-only (no browser host boots `machine/`): move it into the plugin\'s portable `server/`',
      'fixture: config "disk/config.jsonc" registered on web by plugins/disk/web/index.ts is not served by the graph: served by disk/server, which is not portable: it reads the disk',
    ]);
  });
});

describe("resolveHostContributionCoverage", () => {
  const contributions = (
    barrels: Parameters<typeof resolveHostContributionCoverage>[0]["barrels"],
  ) =>
    resolveHostContributionCoverage({
      label: "fixture",
      members: ["app", "registry"],
      webPlugins: [asPluginId("app"), asPluginId("disk")],
      barrels,
      kinds: new Map([
        [
          "registry.entry",
          [{ kind: "registry.entry", absentOnHost: false, plugin: "registry" }],
        ],
        [
          "registry.reaction",
          [
            {
              kind: "registry.reaction",
              absentOnHost: true,
              plugin: "registry",
            },
          ],
        ],
        [
          "elsewhere.entry",
          [
            {
              kind: "elsewhere.entry",
              absentOnHost: false,
              plugin: "elsewhere",
            },
          ],
        ],
      ]),
      blockers: async () => ["it reads the disk"],
    });

  test("an out-of-graph scoped barrel contributing to a member's kind is refused, naming why", async () => {
    const problems = await contributions([
      {
        plugin: "disk",
        barrel: pj("disk/server/index.ts"),
        contributions: [{ kind: "registry.entry", label: "disk" }],
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "disk/server contributes to kinds a graph member reads",
    );
    expect(problems[0]).toContain(
      'registry.entry "disk" (declared by registry)',
    );
    expect(problems[0]).toContain("it is not portable: it reads the disk");
  });

  test("an absentOnHost kind, a kind no member declares and a host service are not its", async () => {
    expect(
      await contributions([
        {
          plugin: "disk",
          barrel: pj("disk/server/index.ts"),
          contributions: [
            { kind: "registry.reaction" },
            { kind: "elsewhere.entry" },
            { kind: "host-service:disk.store" },
          ],
        },
      ]),
    ).toEqual([]);
  });
});
