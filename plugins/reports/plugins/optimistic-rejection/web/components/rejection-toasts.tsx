import { useEffect } from "react";
import {
  useToast,
  type ToastArgs,
} from "@plugins/shell/plugins/notifications/web";
import {
  rejectionToastSink,
  type OptimisticRejectionReport,
} from "../internal/optimistic-rejection-collector";

/** The toast of one rejected write: the edit is gone, and why. */
export function rejectionToast(d: OptimisticRejectionReport): ToastArgs {
  return {
    type: "optimistic-rejection",
    variant: "error",
    category: "other",
    title: d.label
      ? `Couldn't save ${d.label.toLowerCase()} edit`
      : "Couldn't save edit",
    description: d.message,
  };
}

/**
 * Raises the collector's rejections as toasts — each recorded in the
 * notification history like every toast. Mounted once at the page root; the
 * sink holds what arrives before it mounts.
 */
export function RejectionToasts(): null {
  const toast = useToast();
  useEffect(() => {
    rejectionToastSink.register((d) => toast(rejectionToast(d)));
    return () => rejectionToastSink.register(null);
  }, [toast]);
  return null;
}
