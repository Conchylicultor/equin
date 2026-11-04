import { FindingSchema } from "./finding";

/** The report kind a held finding files: one row per rule and subject. */
export const HOST_IO_DEGRADED_KIND = "host-io-degraded";

/** The kind's payload is the finding itself, as it stood when recorded. */
export const HostIoDegradedPayloadSchema = FindingSchema;
