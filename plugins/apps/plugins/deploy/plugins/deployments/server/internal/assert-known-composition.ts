import { getConfig } from "@plugins/config_v2/server";
import { compositionsConfig } from "@plugins/plugin-meta/plugins/composition/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";

/**
 * Refuse a `compositionId` that is not a live composition.
 *
 * This is a write-time check rather than a `./equin check`: a deployment
 * is runtime data, so the moment to fail is when someone saves the name — a repo
 * check would only notice at the next build, by which point the row is already
 * being converged from. It reads the `compositions` config through its own
 * descriptor (the registry that owns it) rather than touching `config_v2` paths.
 *
 * Plain `getConfig` — this backend's own resolved config, the same view the app's
 * composition picker gets from `useManifestItems()`. Deliberately not
 * compose-serve's main-authoritative `readEffectiveConfigFromDisk`: that exists
 * because a *served* composition is provisioned by main regardless of who
 * toggled it, whereas here the only thing that matters is that the picker and the
 * validator agree about what exists.
 *
 * Matched on the composition NAME, which is the identity every derived install
 * name has to agree with: `release --composition <name>` takes it,
 * `RELEASE.json.composition` carries it, and the launcher makes it the runtime
 * namespace. (The seeded compositions all carry `id === name`.)
 *
 * `category` is deliberately NOT consulted. It is documented as organisation
 * metadata the engine never reads, so refusing to deploy a `subsystem` here
 * would hand it engine semantics it disclaims — and the honest refusal for a
 * composition that cannot produce a bundle comes from `ship`, which will not
 * find one.
 */
export function assertKnownComposition(compositionId: string): void {
  const names = getConfig(compositionsConfig).manifests.map((m) => m.name);
  if (names.includes(compositionId)) return;
  throw new HttpError(
    400,
    `"${compositionId}" is not a composition. Known compositions: ${[...names].sort().join(", ")}`,
  );
}
