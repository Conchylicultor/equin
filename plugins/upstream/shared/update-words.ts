import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { releaseVersion } from "@plugins/upstream/plugins/release/core";

/** "2026.10.30 → 2026.11.14", or the new release alone when none is held. */
export function updateSpan(current: string | null, latest: string): string {
  return current === null
    ? `${releaseVersion(latest)} available`
    : `${releaseVersion(current)} → ${releaseVersion(latest)}`;
}

/** The headline of an update to make — the health row's and the reminder's. */
export const OUT_OF_DATE_TITLE = `${PRODUCT_NAME} is out of date`;
