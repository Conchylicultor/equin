import { useMemo } from "react";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { assetFetchOver } from "@plugins/infra/plugins/endpoints/web";
import type { InstrumentAssets } from "./slots";

/**
 * The {@link InstrumentAssets} of this subtree: every sample asset resolved
 * over the subtree's transport. Read by each host that builds voices (the
 * player's engine, live play, another app's keyboard) and handed to
 * `createVoices`.
 */
export function useInstrumentAssets(): InstrumentAssets {
  const transport = useTransport();
  return useMemo(
    () => (asset) => assetFetchOver(transport, asset),
    [transport],
  );
}
