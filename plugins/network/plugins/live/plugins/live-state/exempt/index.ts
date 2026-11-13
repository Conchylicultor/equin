import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/use-resource.ts"],
    kind: "sanctioned",
    reason:
      "Special transport that implement()/fetchEndpoint can't express. Do NOT migrate these. The live-state primitive's own resource GET (`/api/resources/:key`, untyped per resource) — the substrate every live read compiles to; it cannot depend on the typed-endpoint client.",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/notifications-client.ts"],
    kind: "sanctioned",
    reason:
      "Same live-state resource GET, in the client that owns the version-guarded cache write: `primeFromHttp` is the cold-start HTTP prime of the same `/api/resources/:key` route as use-resource's queryFn, kept here because the write needs the client's private sub/schema state (and this file cannot import use-resource — that would be a cycle). Same primitive, same untyped per-resource route, same self-dependency exemption.",
  },
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "The substrate: the live-state client's own HTTP read (useResource's fallback / on-demand fetch over TanStack queries) that every live read compiles to, and useQueryResource, the local-async-load adapter (a code-split module, never a server read).",
  },
  {
    rule: "import-scan-safety/no-hand-import-resolution",
    paths: ["lint/result-constructors.ts"],
    kind: "sanctioned",
    reason:
      "Maps a sanctioned constructor's barrel specifier to its PLUGIN's directory fragment (`/plugins/<p>/`), to tell whether a linted file belongs to the plugin owning the result shape \u2014 a plugin path, never a module file, so there is no import to resolve.",
  },
] satisfies Exemptions;
