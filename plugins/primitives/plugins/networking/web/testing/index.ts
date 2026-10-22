export {
  FakeWebSocket,
  FakeWsServer,
  FakeMessagePort,
  FakeLockManager,
  FakeSharedWorkers,
  FakePageLifecycle,
  createTransportHub,
} from "./transport-fakes";
export type {
  FakeWsServerOptions,
  TabHandle,
  TransportHub,
} from "./transport-fakes";
// A page-shaped transport per test, and the provider mount every component
// reading `useTransport()` needs (the context has no default).
export {
  testTransport,
  transportWrapper,
  renderWithTransport,
} from "./render-with-transport";
export type { RenderWithTransportOptions } from "./render-with-transport";
