# asset-mirror

Generic mirror for remote binary assets, on every host. A plugin declares a
remote source; the primitive downloads each requested file once into its cache
— the `assetMirrorFiles` data-files root over `cache/asset-mirror` — and serves
it same-origin thereafter. On the desktop that root is the computer's disk
(bound by `machine/`, outside any worktree, so the download happens at most
once per machine, and a release bundle seeds it); in a browser host it is
the host's `data-files` store — memory written through to the host's storage
(`browser-server/host-storage`), so with a persistent host (the demo's
IndexedDB) each file is fetched from its remote once per browser profile, and
a returning visitor's samples never leave the browser.

## API

```ts
// server — declare a mirror (add the token to the plugin's `register` array)
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";

export default {
  name: "My Plugin",
  register: [
    defineAssetMirror({
      id: "my-assets",
      remoteBaseUrl: "https://cdn.example.com/assets",
    }),
  ],
} satisfies ServerPluginDefinition;
```

```ts
// web — a library that fetches `<base>/<file>` itself, through a fetch hook
import { assetMirrorBase } from "@plugins/infra/plugins/asset-mirror/core";
import { assetFetchOver } from "@plugins/infra/plugins/endpoints/web";

const at = assetFetchOver(transport, assetMirrorBase("my-assets"));
if (at.kind === "unavailable") return <Text>{at.message}</Text>;
// at.base === "/api/asset-mirror/my-assets"; at.fetch(`${at.base}/logo.png`)
// loads over the subtree's transport — the page's server, or a demo's worker
```

The routes are declarations (`getMirroredFile` / `getMirroredNestedFile` in
`core/`, literal `route:`s) served by the portable `server/` half, so the
browser-host coverage guard reads them like any endpoint. A library that only
takes a URL (frimousse, the emoji picker) resolves the base with
`useAssetUrl`, which answers `fetch-only` on a transport no URL reaches (a
browser host): such a sink says it is not available there. Sonata's samplers
take a fetch hook (`InstrumentAssets`, `apps/sonata/audio/instruments`), so
they play in the demo. There is no hand-spelled `/api/asset-mirror` string.

## Prewarm (offline cold start)

Lazy download is the fallback; it only populates the cache on the **first online
request**. A freshly-installed release launched offline therefore has an empty
cache and degrades silently. To ship assets offline-ready, a plugin declares a
**prewarm contribution** — the set of files the release pipeline should bake into
the bundle for **every mirror in the composition's closure**.

```ts
// <plugin>/prewarm/index.ts — default-export the descriptor
import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { MY_MIRROR_ID, MY_REMOTE_BASE } from "../shared/mirror";

export default defineAssetMirrorPrewarm({
  id: MY_MIRROR_ID, // must match the defineAssetMirror id
  remoteBaseUrl: MY_REMOTE_BASE, // same shared constant as the mirror
  files: ["logo.png", "sample.ogg"], // flat names, exactly as requested at runtime
});
```

The `defineCollectedDir("prewarm")` marker (in this plugin's `core/`) makes
`./equin build` codegen discover every `prewarm/index.ts` into
`core/prewarm.generated.ts`, and a composition build emits the closure-filtered
`core/prewarm.composition.<name>.generated.ts` — keyed by composition name, like
every other filtered registry, so two compositions never share one. The
mechanism:

- **Release** (`release.ts` `[3.5]`) calls
  `runAssetMirrorPrewarm({ composition, destRoot })` (the `bundle` sub-plugin), which reads that
  composition's closure-filtered registry and downloads each declared file into
  `<destRoot>/<id>/<file>` (fail-loud: any failed download aborts the release).
- **Launch** (`launch.ts`) calls `seedAssetMirrorCache({ bundleRoot, dataDir })` (the `bundle` sub-plugin),
  which copies the bundled `asset-mirror/` tree into the cache's declared spot
  beneath `dataDir` **copy-if-absent** — never clobbering a user's
  already-downloaded samples. `dataDir` is a parameter (the target may be a fresh
  install's root, e.g. a preview under `/tmp`), so the subpath comes from
  `assetMirrorRelativeToRoot()` in `data-dirs/` rather than `.path`.

`remoteBaseUrl` is repeated in the mirror and the prewarm descriptor; import the
same constant from the plugin's `shared/` so the literal lives once. The
descriptor is deliberately self-contained data so the release runner reads it
without booting the server.

## Caveats

- **Fail-loud is server-side.** A cache miss that cannot reach the remote source
  logs an error and returns **502** — it never writes a partial/placeholder file.
  Callers that swallow non-200 responses (e.g. smplr's sample loader) will
  therefore degrade silently on the client; the loud signal is the server log +
  the browser Network tab, not a client exception.
- **First request only.** Files are fetched lazily, on demand — there is no
  prefetch. The first (online) use of a consumer populates the cache.
- **Flat names, or one directory deep.** A mirrored path is `:file` or
  `:dir/:file` (e.g. emojibase's `en/data.json`) — the server router has no
  splat, so each depth is its own route key onto one handler. Every segment is
  flat (no `/`, `\`, `..`). Segments are URL-encoded by the consumer and
  decoded server-side, then re-encoded one by one for the upstream fetch.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Generic asset mirror, on every host: plugins declare a remote asset source via defineAssetMirror; GET /api/asset-mirror/:id/:file (and /:id/:dir/:file) downloads each file on its first request into the assetMirrorFiles data-files root and serves it same-origin thereafter — offline-capable after one warm-up on the desktop (the computer's disk, shared by every worktree), once per browser profile in a browser host (its data-files store, kept in the host's storage).
- Server:
  - Contributes: `data-files.root-location` "infra.asset-mirror"
  - Uses:
    - `infra/endpoints.rawEndpointHandler`
    - `infra/paths/data-files.defineFileRoot`
  - Exports (types): `AssetMirrorSpec`
  - Exports (values):
    - `assetMirrorFiles`
    - `defineAssetMirror`
  - Routes:
    - `GET /api/asset-mirror/:id/:file`
    - `GET /api/asset-mirror/:id/:dir/:file`
- Machine:
  - Uses: `infra/paths/data-files.FileRootLocation`
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `infra/endpoints.assetBase`
    - `infra/endpoints.AssetBase`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
  - Exports (types):
    - `AssetMirrorPrewarm`
    - `CollectedEntry`
  - Exports (values):
    - `assetMirrorBase`
    - `assetMirrorPrewarmCollectedDir`
    - `defineAssetMirrorPrewarm`
    - `getMirroredFile`
    - `getMirroredNestedFile`
    - `prewarmEntries`
- Cross-plugin:
  - Imported by:
    - `apps/sonata/audio/piano`
    - `apps/sonata/audio/soundfont`
    - `ui/icons/emoji`
- Sub-plugins:
  - **`bundle`** — The asset mirror's release bundle, host-only: runAssetMirrorPrewarm downloads every prewarm-declared file of a composition's closure into a release bundle, and seedAssetMirrorCache copies a bundle's…

<!-- AUTOGENERATED:END -->
