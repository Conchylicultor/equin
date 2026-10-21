// Browser servers for tests, which cannot start a real Web Worker: a server
// over a runtime in the test's own realm, and a host "worker" that is one end
// of an in-realm MessageChannel serving it — the same port protocol a
// scenario's real worker speaks.
export { channelHost, inRealmServer } from "./in-realm";
export type { InRealmServerOptions } from "./in-realm";
