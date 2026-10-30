import type { Namespace } from "@plugins/infra/plugins/namespace/core";

/**
 * {@link import("./reset").resetCompositionData} for a `./equin` verb acting on
 * this checkout — the same four guards and the same recipe the Reset button's
 * endpoint runs. A CLI process has no runtime namespace, so it names the one
 * whose user config holds this checkout's manifests (`checkoutNamespace(root)`).
 *
 * Loaded lazily, like `handle-reset.ts`: the reset pulls in the composition
 * resolution graph (codegen/core → plugin-tree/facets), which must not sit on
 * the backend's boot path just because this barrel exports it.
 */
export async function resetServedComposition(
  id: string,
  manifestNamespace: Namespace,
): Promise<void> {
  const { resetCompositionData } = await import("./reset");
  await resetCompositionData(id, manifestNamespace);
}
