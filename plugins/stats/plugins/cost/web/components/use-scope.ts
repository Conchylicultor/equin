import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { costConfig } from "../../shared/config";
import type { CostScope } from "../../shared/values";

export function useScope(): {
  scope: CostScope;
  repoOnly: boolean;
  toggle: () => void;
} {
  const { repoOnly } = useConfig(costConfig);
  const setConfig = useSetConfig(costConfig);
  return {
    scope: repoOnly ? "repo" : "all",
    repoOnly,
    toggle: () => setConfig("repoOnly", !repoOnly),
  };
}
