import { useEffect } from "react";
import { subscribeWsStatus } from "@plugins/primitives/plugins/networking/web";
import { isPageOnScreen, showToast } from "@plugins/shell/plugins/toast/web";

export function ReconnectWatcher() {
  useEffect(() => {
    const wasReconnecting = new Set<string>();
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleToast = () => {
      if (toastTimer) return;
      toastTimer = setTimeout(() => {
        toastTimer = null;
        // An announcement: a reconnect the user did not watch is not news (the
        // health report's Connection row has the state), and a toast raised on
        // a hidden page stays mounted until it is shown — one per server
        // restart, per background tab.
        if (!isPageOnScreen()) return;
        showToast({
          description: "Reconnected to server",
          variant: "info",
          audience: "developer",
        });
      }, 150);
    };

    const unsub = subscribeWsStatus(({ url, status }) => {
      if (status === "reconnecting") {
        wasReconnecting.add(url);
      } else if (status === "open" && wasReconnecting.has(url)) {
        wasReconnecting.delete(url);
        scheduleToast();
      } else if (status === "closed") {
        wasReconnecting.delete(url);
      }
    });

    return () => {
      unsub();
      if (toastTimer) clearTimeout(toastTimer);
    };
  }, []);

  return null;
}
