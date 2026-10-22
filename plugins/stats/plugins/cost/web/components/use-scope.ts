import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { costConfig } from "../../shared/config";
import type { CostScope } from "../../shared/values";

export function useScope(): {
  scope: CostScope;
  singularityOnly: boolean;
  toggle: () => void;
} {
  const { singularityOnly } = useConfig(costConfig);
  const setConfig = useSetConfig(costConfig);
  return {
    scope: singularityOnly ? "singularity" : "all",
    singularityOnly,
    toggle: () => setConfig("singularityOnly", !singularityOnly),
  };
}
