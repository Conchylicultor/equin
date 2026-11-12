import { useLive } from "@plugins/network/plugins/live/web";
import { hostHome, tildifyText } from "../../core";

/**
 * A text mapper that shows the home directory as `~` — display only, so the
 * username never sits on screen. Until the home directory is known (or on a
 * host without one) the text is shown as it is; a failed read throws.
 */
export function useHomeDisplay(): (text: string) => string {
  const home = useLive(hostHome);
  switch (home.status) {
    case "error":
      throw home.error;
    case "ready": {
      const dir = home.data.dir;
      return (text) => tildifyText(text, dir);
    }
    case "loading":
    case "unavailable":
      return identity;
  }
}

function identity(text: string): string {
  return text;
}
