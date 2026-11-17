import type { Namespace } from "@plugins/infra/plugins/namespace/core";

/**
 * {@link import("./reset").resetCompositionData} for a `./equin` verb acting on
 * this checkout — the same four guards and the same recipe the Reset button's
 * endpoint runs. A CLI process has no runtime namespace, so it names the one
 * whose user config holds this checkout's manifests (`checkoutNamespace(root)`).
 *
 * Loaded lazily, like `handle-reset.ts`: the reset reaches `database/admin`,
 * which must not sit on the backend's boot path just because this barrel
 * exports it.
 */
export async function resetServedComposition(
  id: string,
  manifestNamespace: Namespace,
  /** This account's gateway port, as the CLI reads it (`gatewayPort()`). */
  gatewayPort: number,
): Promise<void> {
  const { resetCompositionData } = await import("./reset");
  await resetCompositionData(id, gatewayPort, manifestNamespace);
}
