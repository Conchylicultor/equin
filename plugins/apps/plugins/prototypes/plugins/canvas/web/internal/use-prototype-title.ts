import { useLive } from "@plugins/network/plugins/live/web";
import { prototypesList } from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * A prototype pane's tab/document title: the prototype's own `<title>`, or
 * undefined while the list loads or there is no such folder (the pane's
 * fallback is then the id).
 */
export function usePrototypeTitle({
  name,
}: {
  name: string;
}): string | undefined {
  const result = useLive(prototypesList);
  switch (result.status) {
    case "loading":
    case "error":
      return undefined;
    case "ready":
      break;
  }
  return result.data.find((p) => p.name === name)?.title;
}
