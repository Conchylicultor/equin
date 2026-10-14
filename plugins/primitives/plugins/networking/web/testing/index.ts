export {
  FakeWebSocket,
  FakeWsServer,
  FakeMessagePort,
  FakeLockManager,
  FakeSharedWorkers,
  FakePageLifecycle,
  createTransportHub,
} from "./transport-fakes";
// The subtree transport switch, for a test pointing a subtree at a scripted
// backend or a browser server. Public once its first shipping caller (the
// demo scope) imports it — the barrel publishes no name only tests import.
export { TransportProvider } from "../transport";
export type {
  FakeWsServerOptions,
  TabHandle,
  TransportHub,
} from "./transport-fakes";
