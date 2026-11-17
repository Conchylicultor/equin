import { useEffect } from "react";
import { installGestureWatcher } from "./gesture-watcher";

/** Mounts the document gesture watcher once per page; renders nothing. */
export function GestureWatcherRoot(): null {
  useEffect(() => installGestureWatcher(document), []);
  return null;
}
