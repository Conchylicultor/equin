import { useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { recheckMidiFolders } from "../../shared/status";
import { stillUnreadable } from "./folder-copy";

/**
 * Check every watched folder again, for one folder's Check again: `run`
 * resolves when the backend answered (so the button pends meanwhile) and
 * `result` says so when the folder came back unchanged ("Still no access —
 * checked just now"). A folder that became readable simply leaves the
 * notice, through the live status.
 */
export function useCheckAgain(path: string): {
  run: () => Promise<void>;
  result: string | null;
} {
  const fetchEndpoint = useFetchEndpoint();
  const [result, setResult] = useState<string | null>(null);
  const run = async () => {
    const statuses = await fetchEndpoint(recheckMidiFolders, {});
    const same = statuses.find((s) => s.path === path);
    setResult(same && same.state !== "ok" ? stillUnreadable(same) : null);
  };
  return { run, result };
}
