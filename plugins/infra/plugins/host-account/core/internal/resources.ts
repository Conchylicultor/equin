import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { HostAccountSchema } from "./account";

/**
 * The account this instance runs as — the OS account on the desktop, a fixed
 * guest account on a host without the computer (the `HostAccountSource` host
 * service). Read once per backend process (it does not change under a running
 * process) and pushed like any value. No placeholder: until the first read
 * lands, `useLive` reports it loading.
 */
export const hostAccount = liveValue("host-account", {
  schema: HostAccountSchema,
});

/**
 * `dir`: the absolute folder `~` stands for. `standIn`: it is the configured
 * stand-in home folder (`homeFolderConfig`), not the account's own — so a
 * surface must not name anything of the machine outside it.
 */
const HostHomeSchema = z.object({
  dir: z.string().min(1),
  standIn: z.boolean(),
});
export type HostHome = z.infer<typeof HostHomeSchema>;

/**
 * The folder `~` stands for in every host path the server reads: the OS
 * account's home directory, or the configured stand-in home folder. A sibling of
 * {@link hostAccount} rather than a field of it: it is known without the
 * full-name read, so a surface that only needs `~` never waits on (or fails
 * with) that spawn. Served by the machine half.
 */
export const hostHome = liveValue("host-account.home", {
  schema: HostHomeSchema,
  // The process environment of the computer: a host without one (the demo)
  // has no home folder to name, so its readers render the unavailable arm.
  needsMachine: { feature: "Your home folder" },
  // A few bytes, and read by every host path bar (Files, a file pane's
  // header) to spell `~`: resident from the boot
  // snapshot, so no surface has a frame without it.
  preload: "boot-and-keep",
});
