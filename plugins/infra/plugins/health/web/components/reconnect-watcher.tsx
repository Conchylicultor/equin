import { useEffect } from "react";
import { subscribeWsStatus } from "@plugins/primitives/plugins/networking/web";
import { showToast } from "@plugins/shell/plugins/toast/web";

export function ReconnectWatcher() {
  useEffect(() => {
    const wasReconnecting = new Set<string>();
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleToast = () => {
      if (toastTimer) return;
      toastTimer = setTimeout(() => {
        toastTimer = null;
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
