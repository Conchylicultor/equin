import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { HostAccountSchema } from "./account";

/**
 * The OS account this backend runs as. Read once per backend process (it does
 * not change under a running process) and pushed like any value. No
 * placeholder: until the first read lands, `useLive` reports it loading.
 */
export const hostAccount = liveValue("host-account", {
  schema: HostAccountSchema,
});

/**
 * The home directory of the OS account this backend runs as, absolute — what
 * `~` stands for in every host path the server reads. A sibling of
 * {@link hostAccount} rather than a field of it: it is known without the
 * full-name read, so a surface that only needs `~` never waits on (or fails
 * with) that spawn.
 */
export const hostHome = liveValue("host-account.home", {
  schema: z.string().min(1),
});
