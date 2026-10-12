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
// backend (the demo scope will be its first shipping caller).
export { TransportProvider } from "../transport";
export type {
  FakeWsServerOptions,
  TabHandle,
  TransportHub,
} from "./transport-fakes";
