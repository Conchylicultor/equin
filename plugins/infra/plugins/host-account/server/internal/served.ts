import { serveValue } from "@plugins/network/plugins/live/server";
import { hostAccount, type HostAccount } from "../../core";
import { readHostAccount } from "./read-account";

// The account a process runs as does not change while it runs, so the read is
// made once — on first demand — and shared by every later load. A failed read
// is not kept: the next load asks again.
let read: Promise<HostAccount> | null = null;

function loadHostAccount(): Promise<HostAccount> {
  read ??= readHostAccount().catch((err: unknown) => {
    read = null;
    throw err;
  });
  return read;
}

// External: the truth is the OS account database, which no change feed
// observes — and which never changes under a running process, so the value is
// `fixed` (no `notify`). Pushed (the `liveValue` default): one small value, the
// same for every tab.
export const hostAccountServed = serveValue(hostAccount, {
  source: "external",
  changes: {
    fixed: {
      reason: "the OS account a process runs as never changes while it runs",
    },
  },
  loader: loadHostAccount,
});
