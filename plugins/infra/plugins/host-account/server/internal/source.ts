import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { HostAccount } from "../../core";

/**
 * Who the account this instance runs as is — the OS account database, so it
 * needs the computer: the desktop's provider (`host-account#machine`) reads the
 * login name and its full name (`id -F`, the passwd GECOS field). A host
 * without the computer provides a fixed account
 * (`host-account/plugins/guest`), so a surface that greets the user (the Pages
 * brand) renders as it does on the desktop.
 */
export interface HostAccountSourceImpl {
  /** The account, read now. A failed read throws — never a made-up account. */
  read(): Promise<HostAccount>;
}

export const HostAccountSource = defineHostService<HostAccountSourceImpl>(
  "host-account.source",
);
