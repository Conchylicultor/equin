// The launcher's dependency: the Go gateway binary, collected into infra/deps'
// registry through the `default` array (Settings → Dependencies,
// `./equin deps install gateway-binary`). `./equin start` and
// `serve-app` ensure it; a release seals it into the bundle, and the release
// launcher reads it from there.
import { gatewayBinary } from "./internal/gateway";

export {
  GATEWAY_APP_COMPONENT,
  gatewayBinary,
  gatewayBuild,
  gatewaySignature,
} from "./internal/gateway";

export default [gatewayBinary];
